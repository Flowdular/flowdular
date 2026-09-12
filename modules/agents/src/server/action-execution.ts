import { createHash, randomUUID } from 'node:crypto';
import {
	AgentHarnessError,
	boundToolOutput,
	toolTimeoutMs,
	validateJsonValue,
	validateToolInput,
	validateToolOutput,
	type AgentTool,
	type AgentToolAccessAuthorizer,
	type AgentToolContext,
	type JsonValue,
} from '@flowdular/harness';
import {
	actorsEqual,
	normalizeActor,
	type Actor,
	type UserActor,
} from '@flowdular/kernel';
import {
	createJobRunner,
	createJobTraceSink,
	serverLogger,
	type JobBackoff,
	type Tracer,
} from '@flowdular/server';
import type { AgentActionInvocation } from '../domain/types.ts';
import {
	DuplicateActionIdempotencyKeyError,
	type AgentRepository,
} from '../services/repository.ts';

export const AGENT_ACTION_EXECUTION_CAPABILITY = 'agents.actions.v1';

export interface VersionedActionDescriptor {
	readonly id: string;
	readonly contractVersion: number;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema: Readonly<Record<string, unknown>>;
	readonly timeoutMs: number;
	readonly idempotency: 'required';
	readonly risk: 'read' | 'workspace-write';
	readonly cancellation: 'cooperative' | 'not-supported';
}

export interface ActionCancellationResult {
	readonly actionInvocationId: string;
	readonly state: 'acknowledged' | 'not-acknowledged' | 'not-supported';
}

export interface ActionInvocationAccepted {
	readonly actionInvocationId: string;
	readonly created: boolean;
}

export interface ActionExecutionResult {
	readonly actionInvocationId: string;
	readonly status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
	readonly output?: JsonValue;
	readonly code?: string;
}

export interface AgentActionChildContext {
	readonly tenantId: string;
	readonly workflowRunId: string;
	readonly actor: Actor;
	readonly authorizationSubject?: UserActor;
	readonly permissionSnapshot: readonly string[];
}

export interface AgentActionStartContext extends AgentActionChildContext {
	readonly nodeRunId: string;
	readonly signal: AbortSignal;
}

export interface AgentActionExecutionCapability {
	listWorkflowActions(): Promise<readonly VersionedActionDescriptor[]>;
	start(
		request: {
			readonly actionId: string;
			readonly contractVersion: number;
			readonly input: JsonValue;
			readonly idempotencyKey: string;
		},
		context: AgentActionStartContext,
	): Promise<ActionInvocationAccepted>;
	getResult(
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionExecutionResult | null>;
	requestCancel(
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionCancellationResult>;
}

export class AgentActionCapabilityError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AgentActionCapabilityError';
	}
}

export interface AgentActionRuntime {
	readonly capability: AgentActionExecutionCapability;
	start(): void;
	stop(): void;
	dispose(): Promise<void>;
}

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
) {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AgentActionCapabilityError(
			'ACTION_INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	return normalized;
}

function canonical(value: JsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
		.join(',')}}`;
}

function workflowSchema(
	value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
	if (!value || Array.isArray(value) || typeof value !== 'object') return null;
	try {
		validateJsonValue(value, 'ACTION_SCHEMA_INVALID', 'Action schema');
		const serialized = JSON.stringify(value);
		if (serialized.length > 32_768) return null;
		return JSON.parse(serialized) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function descriptor(tool: AgentTool): VersionedActionDescriptor | null {
	const inputSchema = workflowSchema(tool.inputSchema);
	const outputSchema = workflowSchema(tool.outputSchema);
	if (
		!Number.isSafeInteger(tool.contractVersion) ||
		(tool.contractVersion ?? 0) < 1 ||
		!inputSchema ||
		!outputSchema ||
		(tool.risk !== 'read' && tool.risk !== 'workspace-write') ||
		tool.idempotency !== 'required' ||
		(tool.risk === 'workspace-write' &&
			tool.idempotencyProtection !== 'target-ledger') ||
		(tool.cancellation !== 'cooperative' &&
			tool.cancellation !== 'not-supported')
	) {
		return null;
	}
	return {
		id: tool.id,
		contractVersion: tool.contractVersion!,
		description: tool.description,
		requiredPermissions: [...tool.requiredPermissions],
		inputSchema,
		outputSchema,
		timeoutMs: toolTimeoutMs(tool.timeoutMs),
		idempotency: 'required',
		risk: tool.risk,
		cancellation: tool.cancellation,
	};
}

/**
 * The same run-time gate the harness asks before an agent calls the tool. A
 * workflow invocation asks it twice: once before the invocation is persisted,
 * and again before the queued call runs, because the workspace may withdraw its
 * consent while the invocation waits in the queue.
 */
async function assertConsent(
	tool: AgentTool,
	input: unknown,
	context: AgentToolContext,
): Promise<void> {
	if (!tool.consent) return;
	let granted = false;
	let reason: string | undefined;
	try {
		/* Foreign code: a throw is a refusal, never a crash. */
		const decision = await tool.consent.check(input, context);
		granted = decision.granted;
		reason = decision.reason;
	} catch {
		reason = 'ACTION_CONSENT_UNAVAILABLE';
	}
	if (!granted) {
		throw new AgentActionCapabilityError(
			reason !== undefined && /^[A-Z][A-Z0-9_]{2,63}$/.test(reason)
				? reason
				: 'ACTION_CONSENT_REFUSED',
			`Action ${tool.id} was not consented for this workspace.`,
		);
	}
}

function safeCode(error: unknown): string {
	if (
		error instanceof AgentHarnessError ||
		error instanceof AgentActionCapabilityError
	) {
		return error.code;
	}
	return 'ACTION_EXECUTION_FAILED';
}

function trustedAuthorizationSubject(
	actor: Actor,
	subject?: UserActor,
): UserActor {
	const supplied = subject ? normalizeActor(subject) : undefined;
	const derived =
		actor.kind === 'user'
			? actor
			: actor.kind === 'service'
				? actor.configuredBy
				: undefined;
	const trusted = supplied ?? derived;
	if (
		!trusted ||
		trusted.kind !== 'user' ||
		(derived !== undefined && trusted.id !== derived.id)
	) {
		throw new AgentActionCapabilityError(
			'ACTION_INVALID_DELEGATION',
			'The workflow action requires a trusted delegated user.',
		);
	}
	return trusted;
}

/**
 * The page the recovery read answers, and the invocations this worker performs
 * at once: the drain loop's own bound, now the runner's. A pass takes four
 * pages of claims, so a deep queue keeps draining rather than waiting out the
 * poll interval between passes, as the drain loop's own re-kick did.
 */
const ACTION_ROUTING_PAGE = 8;

/**
 * What the loop waits after a pass that raised: its own interval, doubling to
 * ten times that and never past a minute, so a database refusing the claim gets
 * room while a loop slower than a minute keeps its own cadence.
 */
function actionBackoff(intervalMs: number): JobBackoff {
	return {
		initialMs: intervalMs,
		maxMs: Math.max(intervalMs, Math.min(60_000, intervalMs * 10)),
		multiplier: 2,
	};
}

export function createAgentActionExecutionRuntime(
	repository: AgentRepository,
	tools: readonly AgentTool[],
	options: {
		readonly workerId?: string;
		readonly leaseMs?: number;
		readonly now?: () => number;
		readonly authorizeToolAccess?: AgentToolAccessAuthorizer;
		/** Defaults to the process tracer, which is the one `context.tracer` carries. */
		readonly tracer?: Tracer;
	} = {},
): AgentActionRuntime {
	const now = options.now ?? Date.now;
	const leaseMs = options.leaseMs ?? 30_000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
		throw new Error('Agent action lease must be between 1000 and 300000 ms.');
	}
	const workerId =
		options.workerId ?? `agent-action-worker:${process.pid}:${randomUUID()}`;
	const intervalMs = Math.max(1_000, Math.floor(leaseMs / 2));
	const toolById = new Map(tools.map((tool) => [tool.id, tool]));
	const actions = tools
		.map(descriptor)
		.filter((item): item is VersionedActionDescriptor => item !== null)
		.sort((left, right) => left.id.localeCompare(right.id));
	const actionById = new Map(actions.map((action) => [action.id, action]));
	const inFlight = new Map<string, AbortController>();
	const callerSignals = new Map<
		string,
		{ readonly signal: AbortSignal; readonly listener: () => void }
	>();
	let stopped = true;

	const detachCallerSignal = (id: string) => {
		const caller = callerSignals.get(id);
		if (!caller) return;
		caller.signal.removeEventListener('abort', caller.listener);
		callerSignals.delete(id);
	};

	const finish = (id: string) => {
		inFlight.delete(id);
		detachCallerSignal(id);
	};

	const execute = async (
		invocation: AgentActionInvocation,
		controller: AbortController,
	) => {
		const action = actionById.get(invocation.actionId);
		const tool = toolById.get(invocation.actionId);
		if (
			!action ||
			!tool ||
			action.contractVersion !== invocation.contractVersion
		) {
			const completedAt = now();
			await repository.failAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				'ACTION_VERSION_MISSING',
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.failed',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						code: 'ACTION_VERSION_MISSING',
					},
					occurredAt: completedAt,
				},
			);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectAbort: (() => void) | undefined;
		try {
			const currentlyHeld = new Set(
				invocation.authorizationSubject
					? await (options.authorizeToolAccess?.({
							tenantId: invocation.tenantId,
							actor: invocation.authorizationSubject,
							signal: controller.signal,
						}) ?? [])
					: [],
			);
			const permissions = new Set(
				invocation.permissionSnapshot.filter((permission) =>
					currentlyHeld.has(permission),
				),
			);
			if (
				action.requiredPermissions.some(
					(permission) => !permissions.has(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_REVOKED',
					'The workflow actor no longer has permission for this action.',
				);
			}
			const toolContext: AgentToolContext = {
				runId: invocation.workflowRunId,
				tenantId: invocation.tenantId,
				requestedBy: invocation.actor.id,
				invocation: 'workflow-action',
				actor: invocation.actor,
				...(invocation.authorizationSubject
					? { authorizationSubject: invocation.authorizationSubject }
					: {}),
				...(invocation.actor.kind === 'agent'
					? {
							agentId: invocation.actor.id,
							agentName: invocation.actor.label,
						}
					: {}),
				idempotencyKey: invocation.idempotencyKey,
				permissions,
				signal: controller.signal,
			};
			await assertConsent(tool, invocation.input, toolContext);
			const aborted = new Promise<never>((_, reject) => {
				rejectAbort = () =>
					reject(
						new AgentActionCapabilityError(
							'ACTION_EXECUTION_ABORTED',
							'Action execution was aborted.',
						),
					);
				if (controller.signal.aborted) rejectAbort();
				else
					controller.signal.addEventListener('abort', rejectAbort, {
						once: true,
					});
			});
			const result = await Promise.race([
				tool.execute(invocation.input, toolContext),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(
							new AgentActionCapabilityError(
								'ACTION_TIMEOUT',
								`Action ${action.id} exceeded ${action.timeoutMs} ms.`,
							),
						);
						controller.abort('timeout');
					}, action.timeoutMs);
				}),
				aborted,
			]);
			validateJsonValue(result, 'ACTION_OUTPUT_INVALID', 'Action output');
			validateToolOutput(action.outputSchema, result);
			const boundedOutput = boundToolOutput(result);
			if (boundedOutput.truncated) {
				throw new AgentActionCapabilityError(
					'ACTION_OUTPUT_TOO_LARGE',
					'Action output exceeds the 32768 character limit.',
				);
			}
			const completedAt = now();
			await repository.completeAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				result as JsonValue,
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.succeeded',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						contractVersion: invocation.contractVersion,
						workflowRunId: invocation.workflowRunId,
					},
					occurredAt: completedAt,
				},
			);
		} catch (error) {
			if (
				controller.signal.reason === 'cancelled' ||
				controller.signal.reason === 'worker-shutdown' ||
				controller.signal.reason === 'lease-lost'
			) {
				return;
			}
			const code = safeCode(error);
			const completedAt = now();
			await repository.failAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				code,
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.failed',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: { actionId: invocation.actionId, code },
					occurredAt: completedAt,
				},
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (rejectAbort)
				controller.signal.removeEventListener('abort', rejectAbort);
		}
	};

	/* The recovery read answers routing columns alone, so the page is kept here
	   and refilled only once it is drained: a pass reads the queue once per page
	   however many invocations it claims. */
	let queue: { readonly tenantId: string; readonly invocationId: string }[] =
		[];
	let refillable = true;

	const runner = createJobRunner<AgentActionInvocation>({
		name: 'agents.core.actions',
		intervalMs,
		staleAfterMs: leaseMs,
		/* No `heartbeatEveryMs`: the runner's default is a third of the lease, so
		   a renewal the database refuses once is asked again inside the window. */
		backoff: actionBackoff(intervalMs),
		concurrency: ACTION_ROUTING_PAGE,
		batchLimit: ACTION_ROUTING_PAGE * 4,
		logger: serverLogger,
		now,
		onEvent: createJobTraceSink(
			options.tracer ? { tracer: options.tracer } : {},
		),
		claim: async (at) => {
			if (stopped) return null;
			if (queue.length === 0) {
				if (!refillable) {
					refillable = true;
					return null;
				}
				const page = await repository.listRecoverableActions(
					at,
					ACTION_ROUTING_PAGE,
				);
				refillable = page.length === ACTION_ROUTING_PAGE;
				queue = [...page];
			}
			for (;;) {
				const candidate = queue.shift();
				if (!candidate) {
					refillable = true;
					return null;
				}
				/* A row this worker is already performing is not work to take. */
				if (inFlight.has(candidate.invocationId)) continue;
				const invocation = await repository.claimAction(
					candidate.tenantId,
					candidate.invocationId,
					workerId,
					at,
					at + leaseMs,
					{
						tenantId: candidate.tenantId,
						actorId: workerId,
						action: 'agent-action.claimed',
						subjectType: 'agent-action',
						subjectId: candidate.invocationId,
						metadata: {},
						occurredAt: at,
					},
				);
				if (!invocation) continue;
				/* The stop landed while this claim was still in the database. No work
				   starts under it, so the claim goes back to the queue at once rather
				   than holding a lease nothing renews, and dispose cannot be left
				   draining an invocation its abort never reached. */
				if (stopped) {
					await repository.releaseAction(
						invocation.tenantId,
						invocation.id,
						workerId,
					);
					return null;
				}
				inFlight.set(invocation.id, new AbortController());
				return invocation;
			}
		},
		heartbeat: async (invocation, at) =>
			repository.renewActionLease(
				invocation.tenantId,
				invocation.id,
				workerId,
				at + leaseMs,
			),
		perform: async (invocation, signal) => {
			const controller = inFlight.get(invocation.id)!;
			/* The fence aborts the controller the module already tracks, so a lease
			   another process took stops the work where a cancellation does. */
			const lost = () => controller.abort('lease-lost');
			signal.addEventListener('abort', lost, { once: true });
			try {
				await execute(invocation, controller);
			} catch (error) {
				/* A transactional settle can fail with the row still claimed. Keep the
				   process alive so the loop retries after the database recovers. */
				console.error(
					`[agents] worker failed to settle action ${invocation.id}:`,
					error instanceof Error ? error.message : error,
				);
			} finally {
				signal.removeEventListener('abort', lost);
				finish(invocation.id);
			}
			/* A row another process reclaimed is contention rather than work this
			   pass performed, and the pass learns which by the stage raising. */
			signal.throwIfAborted();
		},
	});

	/* The enqueue that just landed is invisible to a pass already reading the
	   queue, so the loop is woken rather than ticked: a tick would join that pass
	   and leave the invocation waiting out the poll interval. */
	const kick = () => {
		if (stopped) return;
		runner.wake();
	};

	const cancellation = async (
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionCancellationResult> => {
		const invocation = await repository.getAction(
			context.tenantId,
			actionInvocationId,
		);
		const actor = normalizeActor(context.actor);
		const action = invocation ? actionById.get(invocation.actionId) : undefined;
		if (
			!invocation ||
			invocation.workflowRunId !== context.workflowRunId ||
			!actor ||
			!actorsEqual(actor, invocation.actor) ||
			!action ||
			action.requiredPermissions.some(
				(permission) => !context.permissionSnapshot.includes(permission),
			)
		) {
			return { actionInvocationId, state: 'not-acknowledged' };
		}
		if (action?.cancellation !== 'cooperative') {
			return { actionInvocationId, state: 'not-supported' };
		}
		const cancelledAt = now();
		const previous = await repository.cancelAction(
			invocation.tenantId,
			invocation.id,
			cancelledAt,
			{
				tenantId: invocation.tenantId,
				actorId: context.actor.id,
				action: 'agent-action.cancelled',
				subjectType: 'agent-action',
				subjectId: invocation.id,
				metadata: { actionId: invocation.actionId },
				occurredAt: cancelledAt,
			},
		);
		if (previous === null) {
			return { actionInvocationId, state: 'not-acknowledged' };
		}
		inFlight.get(invocation.id)?.abort('cancelled');
		detachCallerSignal(invocation.id);
		return { actionInvocationId, state: 'acknowledged' };
	};

	const capability: AgentActionExecutionCapability = {
		listWorkflowActions: async () =>
			actions.map((action) => ({
				...action,
				requiredPermissions: [...action.requiredPermissions],
				inputSchema: structuredClone(action.inputSchema),
				outputSchema: structuredClone(action.outputSchema),
			})),
		async start(request, context) {
			if (context.signal.aborted) {
				throw new AgentActionCapabilityError(
					'ACTION_CANCELLED',
					'Action invocation was cancelled before enqueue.',
				);
			}
			const actor = normalizeActor(context.actor);
			if (!actor) {
				throw new AgentActionCapabilityError(
					'ACTION_INVALID_ACTOR',
					'Action actor is invalid.',
				);
			}
			const tenantId = bounded(context.tenantId, 'tenantId', 1, 128);
			const authorizationSubject = trustedAuthorizationSubject(
				actor,
				context.authorizationSubject,
			);
			const actionId = bounded(request.actionId, 'actionId', 3, 128);
			const action = actionById.get(actionId);
			if (!action || action.contractVersion !== request.contractVersion) {
				throw new AgentActionCapabilityError(
					'ACTION_VERSION_MISSING',
					'Action contract version is unavailable.',
				);
			}
			if (
				action.requiredPermissions.some(
					(permission) => !context.permissionSnapshot.includes(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_DENIED',
					'The workflow actor lacks permission for this action.',
				);
			}
			let authorized: readonly string[];
			try {
				authorized = await (options.authorizeToolAccess?.({
					tenantId,
					actor: authorizationSubject,
					signal: context.signal,
				}) ?? []);
			} catch {
				throw new AgentActionCapabilityError(
					'ACTION_AUTHORIZATION_UNAVAILABLE',
					'Live action authorization is unavailable.',
				);
			}
			const livePermissions = new Set(authorized);
			if (
				action.requiredPermissions.some(
					(permission) => !livePermissions.has(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_REVOKED',
					'The workflow actor no longer has permission for this action.',
				);
			}
			try {
				validateJsonValue(
					request.input,
					'ACTION_INPUT_INVALID',
					'Action input',
				);
				validateToolInput(action.inputSchema, request.input);
			} catch (error) {
				throw new AgentActionCapabilityError(
					'ACTION_INPUT_INVALID',
					error instanceof Error ? error.message : 'Action input is invalid.',
				);
			}
			const inputJson = canonical(request.input);
			if (inputJson.length > 32_768) {
				throw new AgentActionCapabilityError(
					'ACTION_INPUT_TOO_LARGE',
					'Action input exceeds the 32768 character limit.',
				);
			}
			const workflowRunId = bounded(
				context.workflowRunId,
				'workflowRunId',
				1,
				128,
			);
			const nodeRunId = bounded(context.nodeRunId, 'nodeRunId', 1, 128);
			const idempotencyKey = bounded(
				request.idempotencyKey,
				'idempotencyKey',
				8,
				128,
			);
			const permissions = [...new Set(context.permissionSnapshot)].sort();
			const requestHash = createHash('sha256')
				.update(
					JSON.stringify([
						action.id,
						action.contractVersion,
						inputJson,
						workflowRunId,
						nodeRunId,
						actor,
						authorizationSubject,
						permissions,
					]),
				)
				.digest('hex');
			/* A replay of a key this workspace already accepted answers with the
			   invocation it made, before the gate is asked: consent admits new work,
			   and a workflow retrying a node it already enqueued must reach the same
			   invocation however the workspace changed its mind since. The worker
			   asks the gate again before that invocation runs. */
			const existing = await repository.findActionByIdempotencyKey(
				tenantId,
				idempotencyKey,
			);
			if (existing) {
				if (existing.requestHash !== requestHash) {
					throw new AgentActionCapabilityError(
						'ACTION_IDEMPOTENCY_CONFLICT',
						'The idempotency key is bound to another action request.',
					);
				}
				return { actionInvocationId: existing.id, created: false };
			}
			/* Refused before the invocation is persisted, so an unconsented action
			   never occupies the queue; the worker asks again before it runs. */
			await assertConsent(toolById.get(action.id)!, request.input, {
				runId: workflowRunId,
				tenantId,
				requestedBy: actor.id,
				invocation: 'workflow-action',
				actor,
				authorizationSubject,
				idempotencyKey,
				permissions: livePermissions,
				signal: context.signal,
			});
			const invocation: AgentActionInvocation = {
				id: randomUUID(),
				tenantId,
				workflowRunId,
				nodeRunId,
				actionId: action.id,
				contractVersion: action.contractVersion,
				actor,
				authorizationSubject,
				permissionSnapshot: permissions,
				input: request.input,
				idempotencyKey,
				requestHash,
				status: 'queued',
				output: null,
				code: null,
				attempt: 0,
				queuedAt: now(),
				startedAt: null,
				completedAt: null,
				leaseExpiresAt: null,
			};
			try {
				await repository.enqueueAction(invocation, {
					tenantId,
					actorId: actor.id,
					action: 'agent-action.queued',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						contractVersion: invocation.contractVersion,
						workflowRunId,
					},
					occurredAt: invocation.queuedAt,
				});
			} catch (error) {
				if (error instanceof DuplicateActionIdempotencyKeyError) {
					const raced = await repository.findActionByIdempotencyKey(
						tenantId,
						idempotencyKey,
					);
					if (raced?.requestHash === requestHash) {
						return { actionInvocationId: raced.id, created: false };
					}
					throw new AgentActionCapabilityError(
						'ACTION_IDEMPOTENCY_CONFLICT',
						'The idempotency key is bound to another action request.',
					);
				}
				throw error;
			}
			const listener = () => void cancellation(invocation.id, context);
			callerSignals.set(invocation.id, { signal: context.signal, listener });
			context.signal.addEventListener('abort', listener, { once: true });
			/* Abort may race with durable enqueue before the listener exists. Recheck
			   after registration so an already-aborted signal cannot leave queued work. */
			if (context.signal.aborted && callerSignals.has(invocation.id))
				listener();
			kick();
			return { actionInvocationId: invocation.id, created: true };
		},
		async getResult(actionInvocationId, context) {
			const invocation = await repository.getAction(
				bounded(context.tenantId, 'tenantId', 1, 128),
				bounded(actionInvocationId, 'actionInvocationId', 1, 128),
			);
			const actor = normalizeActor(context.actor);
			const action = invocation
				? actionById.get(invocation.actionId)
				: undefined;
			if (
				!invocation ||
				invocation.workflowRunId !== context.workflowRunId ||
				!actor ||
				!actorsEqual(actor, invocation.actor) ||
				!action ||
				action.requiredPermissions.some(
					(permission) => !context.permissionSnapshot.includes(permission),
				)
			) {
				return null;
			}
			if (invocation.status === 'queued' || invocation.status === 'running') {
				return null;
			}
			return {
				actionInvocationId: invocation.id,
				status: invocation.status,
				...(invocation.output === null ? {} : { output: invocation.output }),
				...(invocation.code === null ? {} : { code: invocation.code }),
			};
		},
		requestCancel: cancellation,
	};

	return {
		capability,
		start() {
			if (!stopped) return;
			stopped = false;
			runner.start();
		},
		stop() {
			stopped = true;
			runner.stop();
		},
		async dispose() {
			this.stop();
			for (const id of callerSignals.keys()) detachCallerSignal(id);
			for (const controller of inFlight.values()) {
				controller.abort('worker-shutdown');
			}
			await runner.dispose();
		},
	};
}
