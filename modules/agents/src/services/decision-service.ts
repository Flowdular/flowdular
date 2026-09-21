import {
	askDecisions,
	DECISION_LIMITS,
	type DecisionProviderConfiguration,
	type DecisionQuestion,
	type DecisionResult,
} from '@flowdular/harness/decisions';
import { isDecisionProviderKind } from '../domain/types.ts';
import { credentialContext, type CredentialVault } from './credential-vault.ts';
import {
	AGENT_METERS,
	METER_LIMIT_EXCEEDED,
	type MeterRegistryResolver,
} from './metering.ts';
import type { ProviderRepository } from './provider-repository.ts';
import type { AgentRepository } from './repository.ts';

export class AgentDecisionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 409,
	) {
		super(message);
		this.name = 'AgentDecisionError';
	}
}

/** Who is asking, for the trail. A module id, never a person. */
export interface AgentDecisionCaller {
	readonly moduleId: string;
	readonly ref?: string;
}

export interface AgentDecisionRequest {
	readonly tenantId: string;
	readonly caller: AgentDecisionCaller;
	readonly state: string;
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/* The answers with the connection that produced them. */
export interface AgentDecisionAnswers extends DecisionResult {
	readonly connection: { readonly id: string; readonly key: string };
}

export interface AgentDecisionServiceOptions {
	/* Live, per call: a workspace that switched the flag off between two
	   questions is off for the second one. */
	readonly typedDecisionsEnabled: (tenantId: string) => boolean;
	readonly primeSettings?: (tenantId: string) => Promise<void>;
	readonly meters?: MeterRegistryResolver;
	readonly now?: () => number;
	/* Injected by tests; production asks the provider over the network. */
	readonly ask?: typeof askDecisions;
}

function bounded(value: string, field: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) {
		throw new AgentDecisionError(
			'INVALID_DECISION_REQUEST',
			`${field} is invalid.`,
			400,
		);
	}
	return normalized;
}

/**
 * Typed decisions for one workspace. It resolves that workspace's consented
 * decision connection, unseals its credential for the one call, and keeps
 * neither the credential nor the answers.
 */
export class AgentDecisionService {
	readonly #now: () => number;
	readonly #ask: typeof askDecisions;

	constructor(
		private readonly providers: ProviderRepository,
		private readonly credentials: CredentialVault,
		private readonly audit: AgentRepository,
		private readonly options: AgentDecisionServiceOptions,
	) {
		this.#now = options.now ?? Date.now;
		this.#ask = options.ask ?? askDecisions;
	}

	/** True when a question asked right now would reach a provider. */
	async available(tenantId: string): Promise<boolean> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 128);
		await this.options.primeSettings?.(trustedTenantId);
		if (!this.options.typedDecisionsEnabled(trustedTenantId)) return false;
		return (await this.#usable(trustedTenantId)).id !== null;
	}

	/* The one connection a decision may use: a decision kind, enabled, and
	   consented by an owner. A workspace holding several takes the first usable
	   one by the repository's own stable order, so a disabled connection never
	   hides a consented one. `available` and `ask` choose with this same
	   function, which is what keeps the answer to "is it usable" and the answer
	   to "use it" from disagreeing. */
	async #usable(tenantId: string): Promise<{
		readonly id: string | null;
		readonly key: string;
		/* Why nothing is usable, for the caller's stable code. Null when one is. */
		readonly refusal: 'not-configured' | 'not-consented' | null;
	}> {
		const decisions = (await this.providers.list(tenantId)).filter(
			(connection) => isDecisionProviderKind(connection.kind),
		);
		const usable = decisions.find(
			(connection) => connection.enabled && connection.allowWorkflows,
		);
		if (usable) return { id: usable.id, key: usable.key, refusal: null };
		/* A connection that is enabled and only missing consent names consent;
		   anything else is a workspace with nothing configured to ask. */
		return {
			id: null,
			key: '',
			refusal: decisions.some((connection) => connection.enabled)
				? 'not-consented'
				: 'not-configured',
		};
	}

	async ask(request: AgentDecisionRequest): Promise<AgentDecisionAnswers> {
		const tenantId = bounded(request.tenantId, 'tenantId', 128);
		const caller = bounded(request.caller.moduleId, 'caller', 128);
		const callerRef = request.caller.ref
			? bounded(request.caller.ref, 'callerRef', 200)
			: null;
		const questionCount = Object.keys(request.questions).length;
		if (questionCount < 1 || questionCount > DECISION_LIMITS.questions) {
			throw new AgentDecisionError(
				'INVALID_DECISION_REQUEST',
				`A request carries between 1 and ${DECISION_LIMITS.questions} questions.`,
				400,
			);
		}
		if (
			!request.state.trim() ||
			request.state.length > DECISION_LIMITS.stateLength
		) {
			throw new AgentDecisionError(
				'INVALID_DECISION_REQUEST',
				`state is empty or longer than ${DECISION_LIMITS.stateLength} characters.`,
				400,
			);
		}
		await this.options.primeSettings?.(tenantId);
		if (!this.options.typedDecisionsEnabled(tenantId)) {
			throw new AgentDecisionError(
				'TYPED_DECISIONS_DISABLED',
				'This workspace has not turned typed decisions on.',
			);
		}
		const usable = await this.#usable(tenantId);
		if (!usable.id) {
			throw usable.refusal === 'not-consented'
				? new AgentDecisionError(
						'DECISION_PROVIDER_NOT_CONSENTED',
						'This decision provider has not been consented for workflow use.',
					)
				: new AgentDecisionError(
						'DECISION_PROVIDER_NOT_CONFIGURED',
						'This workspace has no enabled decision provider.',
					);
		}
		/* Asked before the call, for what this call carries, so a workspace past
		   its allowance never reaches the provider. */
		const meters = this.options.meters?.() ?? null;
		if (meters) {
			const verdict = await meters.check({
				tenantId,
				meter: AGENT_METERS.decisions,
				amount: questionCount,
			});
			if (verdict.verdict === 'refused') {
				throw new AgentDecisionError(
					METER_LIMIT_EXCEEDED,
					'This workspace has used its monthly allowance of typed decisions.',
				);
			}
		}
		const stored = await this.providers.get(tenantId, usable.id);
		if (!stored) {
			throw new AgentDecisionError(
				'DECISION_PROVIDER_NOT_CONFIGURED',
				'The decision provider disappeared while the request was prepared.',
			);
		}
		const model = stored.connection.models.find((item) => item.enabled);
		if (!model) {
			throw new AgentDecisionError(
				'DECISION_PROVIDER_NOT_CONFIGURED',
				'The decision provider has no enabled model.',
			);
		}
		const configuration: DecisionProviderConfiguration = {
			kind: 'typesafe',
			model: model.id,
			credential: this.credentials.decrypt(
				stored.credential,
				credentialContext(stored.connection),
			),
			...(stored.connection.baseURL
				? { baseURL: stored.connection.baseURL }
				: {}),
		};
		const result = await this.#ask(configuration, {
			state: request.state,
			questions: request.questions,
		});
		const now = this.#now();
		/* Counted after the answer, keyed by this call, so a repeated call with
		   the same reference counts one fact rather than two. */
		await meters?.record({
			tenantId,
			meter: AGENT_METERS.decisions,
			amount: questionCount,
			at: now,
			...(callerRef ? { sourceRef: `${caller}:${callerRef}` } : {}),
		});
		/* The trail carries who asked and what it cost. The state, the questions
		   and the answers stay with the caller. */
		await this.audit.appendAuditEvent({
			tenantId,
			actorId: caller,
			action: 'agent-provider.decision-asked',
			subjectType: 'agent-provider',
			subjectId: usable.id,
			metadata: {
				caller,
				...(callerRef ? { callerRef } : {}),
				questions: questionCount,
				inputTokens: result.usage.inputTokens,
			},
			occurredAt: now,
		});
		return { ...result, connection: { id: usable.id, key: usable.key } };
	}
}
