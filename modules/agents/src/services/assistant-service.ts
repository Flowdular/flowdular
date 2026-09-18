import { randomUUID } from 'node:crypto';
import { userActor, type UserActor } from '@flowdular/kernel';
import { ASSISTANT_AGENT_ID } from '../agent/assistant.ts';
import type {
	AssistantConversation,
	AssistantReadiness,
	AssistantThread,
	AssistantThreadListQuery,
	AssistantTurn,
} from '../domain/types.ts';
import type { AgentSettingsReader } from '../settings.ts';
import { AgentService, AgentServiceError } from './agent-service.ts';
import type { AgentRepository, PendingAgentAuditEvent } from './repository.ts';

/** The workspace configuration a locked header entry sends a member to. */
const PROVIDERS_HREF = '/agent-providers';
const AGENTS_HREF = '/agents';

const TITLE_MAX = 120;
const MESSAGE_MAX = 8_000;
const THREAD_PAGE_MAX = 100;
const THREAD_PAGE_DEFAULT = 25;
/* How much of the conversation before this turn the run carries. Newest turns
   win the budget, because a question is usually about what was just said. */
const CONTEXT_TURNS = 8;
const CONTEXT_BUDGET = 12_000;

/** What the readiness answer needs about the workspace's provider estate. */
export interface AssistantProviderReadiness {
	hasUsableModel(tenantId: string): Promise<boolean>;
}

/**
 * The member a request acts for. Built from the authenticated principal by the
 * endpoint; the service never reads an identity out of a request body.
 */
export interface AssistantMember {
	readonly tenantId: string;
	readonly accountId: string;
	readonly displayName: string;
	readonly email: string;
	readonly tenantName: string;
	readonly scopes: readonly string[];
}

export interface StartThreadInput {
	readonly message: string;
	readonly title?: string;
}

export interface ContinueThreadInput {
	readonly threadId: string;
	readonly message: string;
}

export interface AssistantThreadPage {
	readonly threads: readonly AssistantThread[];
	readonly last: { readonly updatedAt: number; readonly id: string } | null;
}

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (
		normalized.length < minimum ||
		normalized.length > maximum ||
		normalized.includes('\u0000')
	) {
		throw new AgentServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} supported characters.`,
		);
	}
	return normalized;
}

/* A thread the member did not name is called after what they asked, so a list
   of conversations reads without opening one. */
function titleFromQuestion(question: string): string {
	const line = question.split('\n', 1)[0]!.trim();
	if (line.length === 0) return 'New conversation';
	return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}...`;
}

/**
 * The prompt one turn sends. The turns before it are transcript, bounded in
 * both count and characters, so a long conversation never grows a run past the
 * input the queue accepts.
 */
export function assistantRunInput(
	earlier: readonly AssistantTurn[],
	question: string,
): string {
	const lines: string[] = [];
	let budget = CONTEXT_BUDGET;
	for (const turn of earlier.slice(-CONTEXT_TURNS).reverse()) {
		const exchange = [
			`Member: ${turn.question}`,
			turn.answer === null ? null : `Assistant: ${turn.answer}`,
		]
			.filter((value): value is string => value !== null)
			.join('\n');
		if (exchange.length > budget) break;
		budget -= exchange.length;
		lines.unshift(exchange);
	}
	if (lines.length === 0) return question;
	return [
		'Earlier in this conversation:',
		lines.join('\n'),
		'',
		'The member now asks:',
		question,
	].join('\n');
}

/**
 * Conversations with the workspace assistant.
 *
 * Every read and write is scoped to the trusted tenant and to the calling
 * account, so another member's thread is not found rather than refused, and no
 * owner-level permission opens one. A turn is an ordinary run of the
 * module-owned assistant agent queued as the member who asked, so the tools,
 * limits, budgets, metering and execution trail are the ones this module
 * already owns.
 */
export class AssistantService {
	constructor(
		private readonly repository: AgentRepository,
		private readonly agents: AgentService,
		private readonly providers?: AssistantProviderReadiness,
		private readonly settings?: AgentSettingsReader,
		private readonly now: () => number = Date.now,
	) {}

	/* Live on every request. A workspace that switched the assistant off is
	   refused here, before a thread is read or a run is queued. */
	#assertEnabled(tenantId: string): void {
		if (this.settings?.assistantEnabled(tenantId) === false) {
			throw new AgentServiceError(
				'ASSISTANT_DISABLED',
				'The workspace assistant is switched off for this workspace.',
				409,
			);
		}
	}

	#audit(
		member: AssistantMember,
		action: string,
		threadId: string,
		metadata: Readonly<Record<string, string | number | boolean>> = {},
	): PendingAgentAuditEvent {
		return {
			tenantId: member.tenantId,
			actorId: member.accountId,
			action,
			subjectType: 'assistant-thread',
			subjectId: threadId,
			/* Both identities: the member is the actor, and the assistant agent is
			   named as the agent acting on their behalf, so a reader tells this
			   apart from the same action taken by the member's own click. */
			metadata: { ...metadata, onBehalfOfAgent: ASSISTANT_AGENT_ID },
			occurredAt: this.now(),
		};
	}

	async readiness(member: AssistantMember): Promise<AssistantReadiness> {
		const enabled = this.settings?.assistantEnabled(member.tenantId) !== false;
		const permitted = member.scopes.includes('agents.assistant.use');
		const view = await this.agents.getModuleAgent(
			member.tenantId,
			ASSISTANT_AGENT_ID,
		);
		const providerReady =
			(await this.providers?.hasUsableModel(member.tenantId)) ?? true;
		const bindingConfigured = view?.status === 'active';
		const ready = enabled && permitted && providerReady && bindingConfigured;
		const lockedReason = !enabled
			? ('disabled' as const)
			: !permitted
				? ('forbidden' as const)
				: !providerReady
					? ('provider-missing' as const)
					: !bindingConfigured
						? ('binding-missing' as const)
						: null;
		return {
			enabled,
			permitted,
			providerReady,
			bindingConfigured,
			ready,
			agentId: ASSISTANT_AGENT_ID,
			configureHref:
				lockedReason === 'provider-missing'
					? PROVIDERS_HREF
					: lockedReason === 'binding-missing'
						? AGENTS_HREF
						: null,
			lockedReason,
		};
	}

	async listThreads(
		member: AssistantMember,
		query: AssistantThreadListQuery,
	): Promise<AssistantThreadPage> {
		this.#assertEnabled(member.tenantId);
		const limit = Number.isSafeInteger(query.limit)
			? Math.min(Math.max(1, query.limit), THREAD_PAGE_MAX)
			: THREAD_PAGE_DEFAULT;
		const threads = await this.repository.listAssistantThreads(
			member.tenantId,
			member.accountId,
			{ limit, after: query.after },
		);
		const last = threads.at(-1);
		return {
			threads,
			last: last ? { updatedAt: last.updatedAt, id: last.id } : null,
		};
	}

	async readThread(
		member: AssistantMember,
		threadId: string,
	): Promise<AssistantConversation> {
		this.#assertEnabled(member.tenantId);
		const conversation = await this.repository.readAssistantThread(
			member.tenantId,
			member.accountId,
			bounded(threadId, 'id', 1, 128),
		);
		if (!conversation) throw this.#notFound();
		return {
			thread: conversation.thread,
			turns: await this.#settle(member.tenantId, conversation.turns),
		};
	}

	async startThread(
		member: AssistantMember,
		input: StartThreadInput,
	): Promise<AssistantConversation> {
		this.#assertEnabled(member.tenantId);
		const question = bounded(input.message, 'message', 1, MESSAGE_MAX);
		const title =
			input.title === undefined || input.title.trim() === ''
				? titleFromQuestion(question)
				: bounded(input.title, 'title', 1, TITLE_MAX);
		const at = this.now();
		const threadId = randomUUID();
		const runId = await this.#queueTurn(member, [], question);
		const thread: AssistantThread = {
			id: threadId,
			tenantId: member.tenantId,
			accountId: member.accountId,
			title,
			turnCount: 1,
			createdAt: at,
			updatedAt: at,
		};
		const turn: AssistantTurn = {
			id: randomUUID(),
			threadId,
			tenantId: member.tenantId,
			accountId: member.accountId,
			sequence: 1,
			question,
			answer: null,
			runId,
			status: 'pending',
			failureCode: null,
			createdAt: at,
			updatedAt: at,
		};
		return await this.repository.createAssistantThread(
			thread,
			turn,
			this.#audit(member, 'assistant.thread-started', threadId, { runId }),
		);
	}

	async continueThread(
		member: AssistantMember,
		input: ContinueThreadInput,
	): Promise<AssistantConversation> {
		this.#assertEnabled(member.tenantId);
		const threadId = bounded(input.threadId, 'threadId', 1, 128);
		const question = bounded(input.message, 'message', 1, MESSAGE_MAX);
		const existing = await this.repository.readAssistantThread(
			member.tenantId,
			member.accountId,
			threadId,
		);
		if (!existing) throw this.#notFound();
		const earlier = await this.#settle(member.tenantId, existing.turns);
		const runId = await this.#queueTurn(member, earlier, question);
		const at = this.now();
		const appended = await this.repository.appendAssistantTurn(
			{
				id: randomUUID(),
				threadId,
				tenantId: member.tenantId,
				accountId: member.accountId,
				question,
				answer: null,
				runId,
				status: 'pending',
				failureCode: null,
				createdAt: at,
				updatedAt: at,
			},
			this.#audit(member, 'assistant.turn-added', threadId, { runId }),
		);
		if (!appended) throw this.#notFound();
		return appended;
	}

	async renameThread(
		member: AssistantMember,
		threadId: string,
		title: string,
	): Promise<AssistantThread> {
		this.#assertEnabled(member.tenantId);
		const id = bounded(threadId, 'id', 1, 128);
		const renamed = await this.repository.renameAssistantThread(
			member.tenantId,
			member.accountId,
			id,
			bounded(title, 'title', 1, TITLE_MAX),
			this.now(),
			this.#audit(member, 'assistant.thread-renamed', id),
		);
		if (!renamed) throw this.#notFound();
		return renamed;
	}

	async deleteThread(member: AssistantMember, threadId: string): Promise<void> {
		this.#assertEnabled(member.tenantId);
		const id = bounded(threadId, 'id', 1, 128);
		const deleted = await this.repository.deleteAssistantThread(
			member.tenantId,
			member.accountId,
			id,
			this.#audit(member, 'assistant.thread-deleted', id),
		);
		if (!deleted) throw this.#notFound();
	}

	#notFound(): AgentServiceError {
		/* A thread of another member reads exactly like one that never existed:
		   the refusal itself would say that this member's colleague has a
		   conversation about something. */
		return new AgentServiceError(
			'ASSISTANT_THREAD_NOT_FOUND',
			'Conversation not found.',
			404,
		);
	}

	/**
	 * Copies the answer of every settled run onto the turn that asked for it.
	 * From then on the turn carries that text itself, so run retention may sweep
	 * the run without taking the conversation with it.
	 */
	async #settle(
		tenantId: string,
		turns: readonly AssistantTurn[],
	): Promise<readonly AssistantTurn[]> {
		const settled: AssistantTurn[] = [];
		for (const turn of turns) {
			if (turn.status !== 'pending' || turn.runId === null) {
				settled.push(turn);
				continue;
			}
			const run = await this.repository.getRun(tenantId, turn.runId);
			if (run && (run.status === 'queued' || run.status === 'running')) {
				settled.push(turn);
				continue;
			}
			const at = this.now();
			const outcome =
				run === null
					? {
							answer: null,
							status: 'failed' as const,
							failureCode: 'RUN_UNAVAILABLE',
							settledAt: at,
						}
					: run.status === 'succeeded'
						? {
								answer: run.output ?? '',
								status: 'answered' as const,
								failureCode: null,
								settledAt: at,
							}
						: {
								answer: null,
								status: 'failed' as const,
								failureCode: run.failureCode ?? run.status.toUpperCase(),
								settledAt: at,
							};
			await this.repository.settleAssistantTurn(tenantId, turn.runId, outcome);
			settled.push({ ...turn, ...outcome, updatedAt: at });
		}
		return settled;
	}

	/**
	 * Queues the run that answers one turn. The asking member is the requested
	 * actor and their own permission snapshot travels with the run, so every
	 * tool the run calls is authorized against them and never against the
	 * assistant; the grants are the tools the workspace enabled on the assistant
	 * binding, which the harness then narrows to the ones the member's
	 * permissions already cover.
	 */
	async #queueTurn(
		member: AssistantMember,
		earlier: readonly AssistantTurn[],
		question: string,
	): Promise<string> {
		const view = await this.agents.getModuleAgent(
			member.tenantId,
			ASSISTANT_AGENT_ID,
		);
		if (!view || view.status !== 'active') {
			throw new AgentServiceError(
				'ASSISTANT_NOT_CONFIGURED',
				view?.unavailableReason ??
					'The workspace assistant has no binding naming a usable provider and model.',
				409,
			);
		}
		const actor: UserActor = userActor({
			accountId: member.accountId,
			displayName: member.displayName,
			email: member.email,
		});
		const run = await this.agents.enqueueRun(
			member.tenantId,
			actor,
			member.scopes,
			{
				agentId: ASSISTANT_AGENT_ID,
				trigger: 'playground',
				input: assistantRunInput(earlier, question),
				toolGrants: view.enabledTools,
			},
			{
				tenantName: member.tenantName,
				userDisplayName: member.displayName,
				userEmail: member.email,
			},
		);
		return run.id;
	}
}
