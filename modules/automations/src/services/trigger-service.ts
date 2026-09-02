import {
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from 'node:crypto';
import { normalizeActor, serviceActor, type UserActor } from '@coreloom/kernel';
import type { AgentRunQueue } from '@coreloom/module-agents/server';
import type {
	AutomationTrigger,
	AutomationTriggerSecret,
	CreateAutomationTriggerInput,
} from '../domain/types.ts';
import { AutomationsServiceError } from './automations-service.ts';
import type {
	AutomationsRepository,
	StoredAutomationTrigger,
	StoredAutomationTriggerWithSecret,
} from './repository.ts';
import type { SecretVault } from './secret-vault.ts';
import {
	createAutomationTargetRegistry,
	type AutomationTargetJsonValue,
	type AutomationTargetRegistry,
} from '../server/targets.ts';

export const TRIGGER_SIGNATURE_HEADER = 'x-coreloom-signature';
export const TRIGGER_TIMESTAMP_HEADER = 'x-coreloom-timestamp';
export const TRIGGER_SIGNATURE_VERSION = 'v1';
/* A signature older or newer than this cannot be replayed into a run. */
export const TRIGGER_FRESHNESS_MS = 300_000;
export const MAX_TRIGGER_BODY_BYTES = 16_384;

/* Every rejection answers the same way. A caller must not be able to tell an
   unknown identifier from a wrong signature from a disabled trigger. */
export class TriggerRejectedError extends Error {
	constructor(readonly reason: string) {
		super('The trigger request was rejected.');
		this.name = 'TriggerRejectedError';
	}
}

export interface TriggerFireRequest {
	readonly triggerId: string;
	readonly body: string;
	readonly signature: string | null;
	readonly timestamp: string | null;
}

function secretContext(tenantId: string, triggerId: string): string {
	return `${tenantId}:${triggerId}:automation-trigger`;
}

function bounded(value: string, field: string, max: number): string {
	const normalized = value.trim();
	if (normalized.length < 1 || normalized.length > max) {
		throw new AutomationsServiceError(
			'INVALID_INPUT',
			`${field} must contain 1 to ${max} characters.`,
		);
	}
	return normalized;
}

function trustedUser(input: string | UserActor): UserActor {
	if (typeof input === 'string') {
		const id = bounded(input, 'actorId', 128);
		return { kind: 'user', id, label: id };
	}
	const actor = normalizeActor(input);
	if (!actor || actor.kind !== 'user') {
		throw new AutomationsServiceError('INVALID_ACTOR', 'Actor is invalid.');
	}
	return actor;
}

function targetSelection(
	input: Pick<
		CreateAutomationTriggerInput,
		'targetKind' | 'targetKey' | 'agentId'
	>,
): {
	readonly kind: string;
	readonly key: string;
} {
	return {
		kind: bounded(input.targetKind ?? 'agent', 'targetKind', 64),
		key: bounded(input.targetKey ?? input.agentId ?? '', 'targetKey', 128),
	};
}

function parsedJson(value: string): AutomationTargetJsonValue {
	try {
		return JSON.parse(value) as AutomationTargetJsonValue;
	} catch {
		throw new TriggerRejectedError('body');
	}
}

export function triggerSignature(secret: string, signed: string): string {
	return createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
}

/* What the caller signs: the scheme version, the timestamp it sent, and the
   raw body byte-for-byte, joined by dots. Binding the timestamp into the
   signature is what makes the freshness window unforgeable. */
export function triggerSignedPayload(timestamp: string, body: string): string {
	return `${TRIGGER_SIGNATURE_VERSION}.${timestamp}.${body}`;
}

function constantTimeEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

/* Per-trigger token bucket, keyed by the identifier the caller supplied so an
   unknown one is limited exactly like a real one. Bounded: the oldest windows
   are dropped once the map reaches capacity, so a flood of invented
   identifiers cannot grow it without limit. */
export class TriggerRateLimiter {
	readonly #windows = new Map<string, { count: number; startedAt: number }>();

	constructor(
		private readonly limit = 60,
		private readonly windowMs = 60_000,
		private readonly capacity = 1_000,
	) {}

	allow(key: string, now: number): boolean {
		const current = this.#windows.get(key);
		if (current && now - current.startedAt < this.windowMs) {
			current.count += 1;
			return current.count <= this.limit;
		}
		if (this.#windows.size >= this.capacity) this.#evict(now);
		this.#windows.set(key, { count: 1, startedAt: now });
		return true;
	}

	#evict(now: number): void {
		for (const [key, window] of this.#windows) {
			if (now - window.startedAt >= this.windowMs) this.#windows.delete(key);
		}
		while (this.#windows.size >= this.capacity) {
			const oldest = this.#windows.keys().next();
			if (oldest.done) return;
			this.#windows.delete(oldest.value);
		}
	}
}

export class AutomationTriggerService {
	readonly #limiter: TriggerRateLimiter;
	/* Verified against when no trigger matched, so an unknown identifier costs
	   the same HMAC as a real one and cannot be timed apart. */
	readonly #decoySecret = randomBytes(32).toString('base64url');

	constructor(
		private readonly repository: AutomationsRepository,
		private readonly vault: SecretVault,
		private readonly runs: AgentRunQueue,
		private readonly now: () => number = Date.now,
		limiter?: TriggerRateLimiter,
		private readonly targets: AutomationTargetRegistry = createAutomationTargetRegistry(),
	) {
		this.#limiter = limiter ?? new TriggerRateLimiter();
	}

	list(tenantId: string): readonly AutomationTrigger[] {
		return this.repository
			.listTriggers(tenantId)
			.map((record) => this.present(record));
	}

	create(
		tenantId: string,
		actorInput: string | UserActor,
		input: CreateAutomationTriggerInput,
		permissionSnapshot: readonly string[] = [],
	): AutomationTriggerSecret {
		const trustedTenantId = bounded(tenantId, 'tenantId', 128);
		const configuredBy = trustedUser(actorInput);
		const target = targetSelection(input);
		this.validateTarget(
			trustedTenantId,
			target.kind,
			target.key,
			configuredBy,
			permissionSnapshot,
		);
		const now = this.now();
		const id = randomUUID();
		const secret = randomBytes(32).toString('base64url');
		const trigger = this.repository.createTrigger({
			id,
			tenantId: trustedTenantId,
			targetKind: target.kind,
			targetKey: target.key,
			agentId: target.kind === 'agent' ? target.key : '',
			label: bounded(input.label, 'label', 120),
			secret: this.vault.encrypt(secret, secretContext(trustedTenantId, id)),
			secretRevision: 1,
			enabled: input.enabled === true,
			createdAt: now,
			updatedAt: now,
			createdBy: configuredBy.id,
			configuredBy,
			permissionSnapshot: [...new Set(permissionSnapshot)].sort(),
			lastFiredAt: null,
			acceptedCount: 0,
			rejectedCount: 0,
		});
		const presented = this.present(trigger);
		this.audit(presented, configuredBy.id, 'automation-trigger.created', now, {
			targetKind: trigger.targetKind,
			targetKey: trigger.targetKey,
			enabled: trigger.enabled,
		});
		return { trigger: presented, secret };
	}

	update(
		tenantId: string,
		actorInput: string | UserActor,
		triggerId: string,
		label: string,
		enabled: boolean,
		permissionSnapshot: readonly string[] = [],
		targetInput?: Pick<
			CreateAutomationTriggerInput,
			'targetKind' | 'targetKey' | 'agentId'
		>,
	): AutomationTrigger {
		const trustedTenantId = bounded(tenantId, 'tenantId', 128);
		const configuredBy = trustedUser(actorInput);
		const id = bounded(triggerId, 'id', 128);
		const existing = this.repository.getTrigger(trustedTenantId, id);
		if (!existing) {
			throw new AutomationsServiceError(
				'TRIGGER_NOT_FOUND',
				'Automation trigger not found.',
				404,
			);
		}
		const target = targetInput
			? targetSelection(targetInput)
			: { kind: existing.targetKind, key: existing.targetKey };
		this.validateTarget(
			trustedTenantId,
			target.kind,
			target.key,
			configuredBy,
			permissionSnapshot,
		);
		const now = this.now();
		const updated = this.repository.updateTrigger({
			...existing,
			targetKind: target.kind,
			targetKey: target.key,
			agentId: target.kind === 'agent' ? target.key : '',
			label: bounded(label, 'label', 120),
			enabled: enabled === true,
			updatedAt: now,
			configuredBy,
			permissionSnapshot: [...new Set(permissionSnapshot)].sort(),
		});
		if (!updated) {
			throw new AutomationsServiceError(
				'TRIGGER_NOT_FOUND',
				'Automation trigger not found.',
				404,
			);
		}
		const presented = this.present(updated);
		this.audit(presented, configuredBy.id, 'automation-trigger.updated', now, {
			targetKind: target.kind,
			targetKey: target.key,
			enabled: updated.enabled,
		});
		return presented;
	}

	rotate(
		tenantId: string,
		actorId: string,
		triggerId: string,
	): AutomationTriggerSecret {
		const trustedTenantId = bounded(tenantId, 'tenantId', 128);
		const id = bounded(triggerId, 'id', 128);
		const now = this.now();
		const secret = randomBytes(32).toString('base64url');
		const rotated = this.repository.rotateTriggerSecret(
			trustedTenantId,
			id,
			this.vault.encrypt(secret, secretContext(trustedTenantId, id)),
			now,
		);
		if (!rotated) {
			throw new AutomationsServiceError(
				'TRIGGER_NOT_FOUND',
				'Agent trigger not found.',
				404,
			);
		}
		const presented = this.present(rotated);
		this.audit(presented, actorId, 'automation-trigger.rotated', now, {
			secretRevision: rotated.secretRevision,
		});
		return { trigger: presented, secret };
	}

	delete(tenantId: string, actorId: string, triggerId: string): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 128);
		const id = bounded(triggerId, 'id', 128);
		const existing = this.repository.getTrigger(trustedTenantId, id);
		if (!existing) {
			throw new AutomationsServiceError(
				'TRIGGER_NOT_FOUND',
				'Agent trigger not found.',
				404,
			);
		}
		const now = this.now();
		this.repository.deleteTrigger(trustedTenantId, id);
		this.audit(existing, actorId, 'automation-trigger.deleted', now, {
			targetKind: existing.targetKind,
			targetKey: existing.targetKey,
		});
	}

	/* The unauthenticated ingress. It proves the caller holds the signing secret
	   and that the request is recent, then queues the run. Everything else
	   raises the one rejection this endpoint knows. */
	async fire(request: TriggerFireRequest): Promise<{ readonly id: string }> {
		const now = this.now();
		const id = request.triggerId;
		if (!this.#limiter.allow(id, now)) {
			throw new TriggerRejectedError('rate-limited');
		}
		const trigger =
			id.length <= 128 ? this.repository.findTriggerForFire(id) : null;
		const signature = this.#verify(request, this.#secretOf(trigger), now);
		if (!trigger) throw new TriggerRejectedError('unknown');
		/* Signature first: without it, a caller could still learn which
		   identifiers exist from the disabled branch. */
		if (!signature) {
			this.#reject(trigger, 'signature', now);
			throw new TriggerRejectedError('signature');
		}
		if (!trigger.enabled) {
			this.#reject(trigger, 'disabled', now);
			throw new TriggerRejectedError('disabled');
		}
		const body = request.body;
		if (body.length === 0 || Buffer.byteLength(body) > MAX_TRIGGER_BODY_BYTES) {
			this.#reject(trigger, 'body', now);
			throw new TriggerRejectedError('body');
		}
		try {
			let runId: string;
			let created: boolean;
			if (trigger.targetKind === 'agent') {
				const actor = serviceActor({
					serviceId: `trigger:${trigger.id}`,
					label: `Webhook trigger: ${trigger.label}`,
					configuredBy: trigger.configuredBy,
				});
				const accepted = await this.runs.enqueueWithOutcome(
					{
						tenantId: trigger.tenantId,
						actor,
						permissionSnapshot: [],
					},
					{
						agentId: trigger.targetKey,
						trigger: 'workflow',
						input: body,
						toolGrants: [],
						idempotencyKey: `trigger:${trigger.id}:${signature.slice(0, 48)}`,
					},
				);
				runId = accepted.run.id;
				created = accepted.created;
			} else {
				const adapter = this.targets.get(trigger.targetKind);
				if (!adapter || !adapter.available()) {
					throw new AutomationsServiceError(
						'AUTOMATION_TARGET_UNAVAILABLE',
						'The automation target is unavailable.',
						503,
					);
				}
				const result = await adapter.invoke(
					{ targetKey: trigger.targetKey, input: parsedJson(body) },
					{
						tenantId: trigger.tenantId,
						configuredBy: trigger.configuredBy,
						permissionSnapshot: trigger.permissionSnapshot,
						source: {
							kind: 'webhook',
							triggerId: trigger.id,
							acceptedSignatureDigest: signature,
						},
					},
				);
				runId = result.correlationId;
				created = result.created;
			}
			if (created) {
				this.repository.recordTriggerOutcome(trigger.id, true, now);
				this.audit(
					trigger,
					`trigger:${trigger.id}`,
					'automation-trigger.fired',
					now,
					{
						runId,
						targetKind: trigger.targetKind,
					},
				);
			}
			return { id: runId };
		} catch (error) {
			const code =
				typeof (error as { code?: unknown })?.code === 'string'
					? String((error as { code: string }).code)
					: 'TRIGGER_FIRE_FAILED';
			this.#reject(trigger, code, now);
			throw new TriggerRejectedError(code);
		}
	}

	#secretOf(trigger: StoredAutomationTriggerWithSecret | null): string {
		if (!trigger) return this.#decoySecret;
		try {
			return this.vault.decrypt(
				trigger.secret,
				secretContext(trigger.tenantId, trigger.id),
			);
		} catch {
			return this.#decoySecret;
		}
	}

	/* Returns the accepted signature, or null. The HMAC is always computed, so a
	   missing trigger and a wrong secret take the same path. */
	#verify(
		request: TriggerFireRequest,
		secret: string,
		now: number,
	): string | null {
		const timestamp = request.timestamp ?? '';
		const submitted = (request.signature ?? '').startsWith(
			`${TRIGGER_SIGNATURE_VERSION}=`,
		)
			? (request.signature ?? '').slice(TRIGGER_SIGNATURE_VERSION.length + 1)
			: '';
		const expected = triggerSignature(
			secret,
			triggerSignedPayload(timestamp, request.body),
		);
		const sent = Number(timestamp);
		const fresh =
			/^\d{1,15}$/.test(timestamp) &&
			Number.isSafeInteger(sent) &&
			Math.abs(now - sent) <= TRIGGER_FRESHNESS_MS;
		return constantTimeEquals(submitted, expected) && fresh ? expected : null;
	}

	#reject(trigger: StoredAutomationTrigger, reason: string, now: number): void {
		this.repository.recordTriggerOutcome(trigger.id, false, now);
		this.audit(
			trigger,
			`trigger:${trigger.id}`,
			'automation-trigger.rejected',
			now,
			{
				reason,
			},
		);
	}

	private present(trigger: StoredAutomationTrigger): AutomationTrigger {
		let targetName = trigger.targetKey;
		let targetAvailable = false;
		if (trigger.targetKind === 'agent') {
			const agent = this.runs
				.listAgents(trigger.tenantId)
				.find((candidate) => candidate.id === trigger.targetKey);
			if (agent) {
				targetName = agent.name;
				targetAvailable = agent.status === 'active';
			}
		} else {
			const adapter = this.targets.get(trigger.targetKind);
			if (adapter?.available()) {
				try {
					const reference = adapter
						.list({
							tenantId: trigger.tenantId,
							actor: trigger.configuredBy,
							permissionSnapshot: trigger.permissionSnapshot,
						})
						.find((target) => target.key === trigger.targetKey);
					if (reference) {
						targetName = reference.label;
						targetAvailable = true;
					}
				} catch {
					/* Revoked workflow access leaves the saved target visible but unavailable. */
				}
			}
		}
		return {
			id: trigger.id,
			tenantId: trigger.tenantId,
			targetKind: trigger.targetKind,
			targetKey: trigger.targetKey,
			targetName,
			targetAvailable,
			agentId: trigger.agentId,
			agentName: targetName,
			label: trigger.label,
			enabled: trigger.enabled,
			secretRevision: trigger.secretRevision,
			createdAt: trigger.createdAt,
			updatedAt: trigger.updatedAt,
			createdBy: trigger.createdBy,
			lastFiredAt: trigger.lastFiredAt,
			acceptedCount: trigger.acceptedCount,
			rejectedCount: trigger.rejectedCount,
		};
	}

	private validateTarget(
		tenantId: string,
		kind: string,
		key: string,
		actor: UserActor,
		permissionSnapshot: readonly string[],
	): void {
		if (kind === 'agent') {
			if (!this.runs.listAgents(tenantId).some((agent) => agent.id === key)) {
				throw new AutomationsServiceError(
					'AGENT_NOT_FOUND',
					'Agent not found.',
					404,
				);
			}
			return;
		}
		const adapter = this.targets.get(kind);
		if (!adapter || !adapter.available()) {
			throw new AutomationsServiceError(
				'AUTOMATION_TARGET_UNAVAILABLE',
				'The automation target is unavailable.',
				503,
			);
		}
		try {
			adapter.validate(key, {
				tenantId,
				actor,
				permissionSnapshot: [...new Set(permissionSnapshot)].sort(),
			});
		} catch (error) {
			const code =
				typeof (error as { code?: unknown })?.code === 'string'
					? String((error as { code: string }).code)
					: 'AUTOMATION_TARGET_REFUSED';
			const status =
				typeof (error as { status?: unknown })?.status === 'number'
					? Number((error as { status: number }).status)
					: 409;
			throw new AutomationsServiceError(
				code,
				error instanceof Error ? error.message : 'The target was refused.',
				status,
			);
		}
	}

	private audit(
		trigger: Pick<AutomationTrigger, 'tenantId' | 'id'>,
		actorId: string,
		action: string,
		occurredAt: number,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): void {
		this.repository.appendAuditEvent({
			tenantId: trigger.tenantId,
			actorId,
			action,
			subjectType: 'automation-trigger',
			subjectId: trigger.id,
			metadata,
			occurredAt,
		});
	}
}
