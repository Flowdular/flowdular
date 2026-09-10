import { randomUUID } from 'node:crypto';
import type {
	AgentActionExecutionCapability,
	AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import type {
	JsonValue,
	WorkflowCostRollupV1,
	WorkflowNodeV1,
	WorkflowUsageRollupV1,
} from '../domain/types.ts';
import { WORKFLOW_LIMITS } from '../domain/types.ts';
import {
	applyWorkflowMappings,
	evaluateGate,
	jsonByteSize,
	jsonHash,
	validateJsonSchema,
} from '../domain/graph.ts';
import { safePayloadEvidence } from './payload-codec.ts';
import type { WorkflowRunRecord, WorkflowsRepository } from './repository.ts';

export interface WorkflowWorkerOptions {
	readonly workerId?: string;
	readonly leaseMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
}

const TERMINAL = new Set(['succeeded', 'failed', 'refused', 'cancelled']);

function inputSchema(node: WorkflowNodeV1): string {
	if (node.type === 'input')
		return node.outputPorts[0]?.schemaId ?? 'workflow.input';
	return node.inputPorts[0]?.schemaId ?? 'workflow.input';
}

function outputSchema(node: WorkflowNodeV1, port: string): string {
	if (node.type === 'output')
		return node.inputPorts[0]?.schemaId ?? 'workflow.output';
	return (
		node.outputPorts.find((entry) => entry.name === port)?.schemaId ??
		'workflow.output'
	);
}

function backoff(node: WorkflowNodeV1, attempt: number): number | null {
	const policy = node.failurePolicy;
	if (!policy || attempt >= policy.maxAttempts) return null;
	const computed =
		policy.backoff.kind === 'fixed'
			? policy.backoff.initialMs
			: policy.backoff.initialMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(policy.backoff.maximumMs, computed);
}

function finalUsage(run: WorkflowRunRecord): WorkflowUsageRollupV1 {
	return { ...run.usage, state: 'final' };
}

function finalCost(run: WorkflowRunRecord): WorkflowCostRollupV1 {
	return { ...run.cost, state: 'final' };
}

function childContext(run: WorkflowRunRecord) {
	return {
		tenantId: run.tenantId,
		workflowRunId: run.id,
		actor: run.actor,
		...(run.authorizationSubject
			? { authorizationSubject: run.authorizationSubject }
			: {}),
		permissionSnapshot: run.permissionSnapshot,
	};
}

function stableCapabilityCode(error: unknown, fallback: string): string {
	if (
		error !== null &&
		typeof error === 'object' &&
		'code' in error &&
		typeof error.code === 'string' &&
		/^[A-Z][A-Z0-9_]{2,127}$/.test(error.code)
	) {
		return error.code;
	}
	return fallback;
}

export class WorkflowWorker {
	readonly #workerId: string;
	readonly #leaseMs: number;
	readonly #pollMs: number;
	readonly #now: () => number;
	#poll: ReturnType<typeof setInterval> | undefined;
	#scheduled = false;
	#running = false;
	#stopped = true;
	readonly #idleWaiters = new Set<() => void>();

	constructor(
		private readonly repository: WorkflowsRepository,
		private readonly capabilities: () => {
			readonly agents: AgentRevisionExecutionCapability;
			readonly actions: AgentActionExecutionCapability;
		} | null,
		options: WorkflowWorkerOptions = {},
	) {
		this.#workerId =
			options.workerId ?? `workflow-worker:${process.pid}:${randomUUID()}`;
		this.#leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
		this.#pollMs = Math.max(250, options.pollMs ?? 1_000);
		this.#now = options.now ?? Date.now;
	}

	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		this.#poll = setInterval(() => this.kick(), this.#pollMs);
		this.#poll.unref?.();
		this.kick();
	}

	stop(): Promise<void> | null {
		this.#stopped = true;
		if (this.#poll) clearInterval(this.#poll);
		this.#poll = undefined;
		if (!this.#running) return null;
		return new Promise((resolve) => this.#idleWaiters.add(resolve));
	}

	kick(): void {
		if (this.#stopped || this.#scheduled || this.#running) return;
		this.#scheduled = true;
		setTimeout(() => {
			this.#scheduled = false;
			void this.#drain().catch((error: unknown) => {
				console.error(
					'[workflows] worker drain failed:',
					error instanceof Error ? error.message : error,
				);
			});
		}, 0);
	}

	async #drain(): Promise<void> {
		if (this.#stopped || this.#running) return;
		this.#running = true;
		try {
			await this.repository.applyPayloadRetention(this.#now());
			const now = this.#now();
			const run = await this.repository.claimNext(
				this.#workerId,
				now,
				now + this.#leaseMs,
			);
			if (run) await this.#execute(run);
		} finally {
			this.#running = false;
			for (const resolve of this.#idleWaiters) resolve();
			this.#idleWaiters.clear();
		}
	}

	async #execute(run: WorkflowRunRecord): Promise<void> {
		const dependencies = this.capabilities();
		if (!dependencies) {
			await this.repository.releaseLease(run.tenantId, run.id, this.#workerId);
			return;
		}
		let leaseLost = false;
		const assertLease = () => {
			if (leaseLost) throw new Error('WORKFLOW_LEASE_LOST');
		};
		const renewal = setInterval(
			() => {
				/* A renewal that loses the race marks the lease lost for the next
				   assertLease call; the timer itself cannot await. */
				void this.repository
					.renewLease(
						run.tenantId,
						run.id,
						this.#workerId,
						this.#now() + this.#leaseMs,
					)
					.then((renewed) => {
						if (!renewed) leaseLost = true;
					})
					.catch(() => {
						leaseLost = true;
					});
			},
			Math.max(500, Math.floor(this.#leaseMs / 2)),
		);
		renewal.unref?.();
		try {
			const current = await this.repository.getRun(run.tenantId, run.id);
			if (!current || TERMINAL.has(current.status)) return;
			const now = this.#now();
			if (current.status === 'cancel-requested') {
				await this.#cancel(current, dependencies);
				return;
			}
			if (now - current.queuedAt > WORKFLOW_LIMITS.maxLiveDurationMs) {
				await this.repository.settleRun(
					current.tenantId,
					current.id,
					'refused',
					'WORKFLOW_LIMIT_EXCEEDED',
					undefined,
					safePayloadEvidence(undefined, 'workflow.output'),
					finalUsage(current),
					finalCost(current),
					now,
				);
				return;
			}
			await this.#advance(current, dependencies, assertLease);
		} catch (error) {
			if (leaseLost) return;
			const current = await this.repository.getRun(run.tenantId, run.id);
			if (current?.status === 'cancel-requested') {
				console.error(
					`[workflows] cancellation observation failed for run ${run.id}:`,
					error instanceof Error ? error.message : error,
				);
				return;
			}
			if (current && !TERMINAL.has(current.status)) {
				const code =
					error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
						? error.message
						: 'WORKFLOW_RECOVERY_INCONSISTENT';
				await this.repository.settleRun(
					current.tenantId,
					current.id,
					'refused',
					code,
					undefined,
					safePayloadEvidence(undefined, 'workflow.output'),
					finalUsage(current),
					finalCost(current),
					this.#now(),
				);
			}
		} finally {
			clearInterval(renewal);
			await this.repository.releaseLease(run.tenantId, run.id, this.#workerId);
		}
	}

	async #cancel(
		run: WorkflowRunRecord,
		dependencies: {
			readonly agents: AgentRevisionExecutionCapability;
			readonly actions: AgentActionExecutionCapability;
		},
	): Promise<void> {
		const now = this.#now();
		const priorEvents = await this.repository.readEvents(
			run.tenantId,
			run.id,
			0,
			WORKFLOW_LIMITS.maxRunEvents,
		);
		let pending = false;
		for (const node of await this.repository.readNodeStates(
			run.tenantId,
			run.id,
		)) {
			const attempt = node.attempts.at(-1);
			if (!attempt || attempt.status !== 'waiting-child' || !attempt.childId)
				continue;
			if (!attempt.childKind) throw new Error('WORKFLOW_RECOVERY_INCONSISTENT');
			const alreadyRequested = priorEvents.some(
				(event) =>
					event.type === 'node.cancel.requested' &&
					event.payload.nodeId === node.nodeId &&
					event.payload.attempt === attempt.attempt &&
					event.payload.childId === attempt.childId,
			);
			if (!alreadyRequested) {
				await this.repository.appendRunEvent(
					run.tenantId,
					run.id,
					'node.cancel.requested',
					{
						nodeId: node.nodeId,
						attempt: attempt.attempt,
						childKind: attempt.childKind,
						childId: attempt.childId,
					},
					now,
				);
				let cancellation:
					| { readonly acknowledged: true }
					| { readonly acknowledged: false; readonly reason: string };
				try {
					if (attempt.childKind === 'agent') {
						cancellation = (await dependencies.agents.requestCancel(
							attempt.childId,
							childContext(run),
						))
							? { acknowledged: true }
							: { acknowledged: false, reason: 'not-acknowledged' };
					} else {
						const result = await dependencies.actions.requestCancel(
							attempt.childId,
							childContext(run),
						);
						cancellation =
							result.state === 'acknowledged'
								? { acknowledged: true }
								: { acknowledged: false, reason: result.state };
					}
				} catch (error) {
					cancellation = {
						acknowledged: false,
						reason: stableCapabilityCode(error, 'CHILD_CANCELLATION_REFUSED'),
					};
				}
				await this.repository.appendRunEvent(
					run.tenantId,
					run.id,
					cancellation.acknowledged
						? 'node.cancel.acknowledged'
						: 'node.cancel.not-acknowledged',
					{
						nodeId: node.nodeId,
						attempt: attempt.attempt,
						childKind: attempt.childKind,
						childId: attempt.childId,
						...(cancellation.acknowledged
							? {}
							: { reason: cancellation.reason }),
					},
					now,
				);
			}

			let childResult:
				| Awaited<ReturnType<AgentRevisionExecutionCapability['getResult']>>
				| Awaited<ReturnType<AgentActionExecutionCapability['getResult']>> =
				null;
			try {
				childResult =
					attempt.childKind === 'agent'
						? await dependencies.agents.getResult(
								attempt.childId,
								childContext(run),
							)
						: await dependencies.actions.getResult(
								attempt.childId,
								childContext(run),
							);
			} catch {
				childResult = null;
			}
			const timedOut =
				attempt.childObservationDeadlineAt === null ||
				now >= attempt.childObservationDeadlineAt;
			if (!childResult && !timedOut) {
				pending = true;
				continue;
			}
			if (
				timedOut &&
				!priorEvents.some(
					(event) =>
						event.type === 'node.cancel.not-acknowledged' &&
						event.payload.nodeId === node.nodeId &&
						event.payload.attempt === attempt.attempt &&
						event.payload.reason === 'child-observation-timeout',
				)
			) {
				await this.repository.appendRunEvent(
					run.tenantId,
					run.id,
					'node.cancel.not-acknowledged',
					{
						nodeId: node.nodeId,
						attempt: attempt.attempt,
						childKind: attempt.childKind,
						childId: attempt.childId,
						reason: 'child-observation-timeout',
					},
					now,
				);
			}
			const rawOutput = childResult
				? 'structuredOutput' in childResult
					? (childResult.structuredOutput ?? childResult.output ?? undefined)
					: childResult.output
				: undefined;
			/* A result observed only after cancellation is never data flow. Keep its
			   hash and size, but do not expose a preview without a selected output
			   port whose schema and read mask could authorize that preview. */
			const evidence = safePayloadEvidence(rawOutput, 'workflow.output', {
				schema: { 'x-flowdular-secret': true },
				permissionSnapshot: run.permissionSnapshot,
			});
			if (childResult) {
				if (
					attempt.childKind === 'agent' &&
					'usage' in childResult &&
					childResult.usage
				) {
					await this.repository.recordAgentUsage(
						run.tenantId,
						run.id,
						attempt.childId,
						childResult.usage,
					);
				}
				await this.repository.appendRunEvent(
					run.tenantId,
					run.id,
					'node.result.late-ignored',
					{
						nodeId: node.nodeId,
						attempt: attempt.attempt,
						childKind: attempt.childKind,
						childId: attempt.childId,
						terminalStatus: childResult.status,
						outputHash: jsonHash(rawOutput ?? null),
						evidenceState: evidence.state,
					},
					now,
				);
			}
			await this.repository.settleAttempt(
				{
					tenantId: run.tenantId,
					runId: run.id,
					nodeId: node.nodeId,
					attempt: attempt.attempt,
					status: 'cancelled',
					outcomePort: null,
					outputEvidence: evidence,
					schemaId: 'workflow.output',
					failureCode: timedOut ? 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT' : null,
					retryClassification: null,
					selectedBackoffMs: null,
					nextAttemptAt: null,
					recordedAt: now,
				},
				run.actor,
				run.origin,
			);
		}
		if (pending) return;
		const fresh = (await this.repository.getRun(run.tenantId, run.id)) ?? run;
		await this.repository.settleRun(
			run.tenantId,
			run.id,
			'cancelled',
			null,
			undefined,
			safePayloadEvidence(undefined, 'workflow.output'),
			finalUsage(fresh),
			finalCost(fresh),
			now,
		);
	}

	async #advance(
		run: WorkflowRunRecord,
		dependencies: {
			readonly agents: AgentRevisionExecutionCapability;
			readonly actions: AgentActionExecutionCapability;
		},
		assertLease: () => void,
	): Promise<void> {
		const nodeById = new Map(run.graph.nodes.map((node) => [node.id, node]));
		for (const nodeId of run.compiledOrder) {
			assertLease();
			const freshRun = await this.repository.getRun(run.tenantId, run.id);
			if (!freshRun || freshRun.status === 'cancel-requested') return;
			const node = nodeById.get(nodeId);
			if (!node) throw new Error('WORKFLOW_RECOVERY_INCONSISTENT');
			const state = (
				await this.repository.readNodeStates(run.tenantId, run.id)
			).find((entry) => entry.nodeId === nodeId);
			if (!state) throw new Error('WORKFLOW_RECOVERY_INCONSISTENT');
			if (
				['succeeded', 'failed', 'refused', 'skipped', 'cancelled'].includes(
					state.status,
				)
			) {
				continue;
			}
			if (
				state.status === 'waiting-retry' &&
				(state.nextAttemptAt ?? Infinity) > this.#now()
			) {
				return;
			}

			const incoming = run.graph.edges
				.filter((edge) => edge.target.nodeId === node.id)
				.sort((left, right) => left.id.localeCompare(right.id));
			const settled = await this.repository.readEdgeTransfers(
				run.tenantId,
				run.id,
			);
			if (
				node.type !== 'input' &&
				incoming.some(
					(edge) => !settled.some((item) => item.edgeId === edge.id),
				)
			) {
				return;
			}
			const emitted = incoming.filter(
				(edge) =>
					settled.find((item) => item.edgeId === edge.id)?.state === 'emitted',
			);
			if (node.type !== 'input' && emitted.length === 0) {
				await this.#skip(run, node, 'upstream-branch-closed');
				continue;
			}
			const values = [];
			for (const edge of emitted) {
				const payload = await this.repository.readEdgePayload(
					run.tenantId,
					run.id,
					edge.id,
				);
				if (payload === undefined) {
					throw new Error('WORKFLOW_RECOVERY_INCONSISTENT');
				}
				values.push({ edge, payload });
			}
			const baseInput: JsonValue =
				node.type === 'input'
					? await this.repository.readExecutionPayload(
							run.tenantId,
							run.id,
							run.inputPayloadId,
						)
					: node.type === 'merge'
						? values.map((entry) => entry.payload)
						: (values[0]?.payload ?? null);
			const outputs = new Map<string, JsonValue>();
			for (const entry of values) {
				outputs.set(
					`${entry.edge.source.nodeId}:${entry.edge.source.port}`,
					entry.payload,
				);
			}
			// A mapping can reference any actual ancestor, not only a direct input.
			// Read only referenced, emitted envelopes and retain tenant/run scoping.
			const mappingSources = (node.mappings ?? []).flatMap<{
				readonly sourceNodeId: string;
				readonly sourcePort: string;
			}>((mapping) =>
				mapping.binding.kind === 'path'
					? [mapping.binding]
					: mapping.binding.kind === 'template'
						? mapping.binding.variables
						: [],
			);
			for (const source of mappingSources) {
				const key = `${source.sourceNodeId}:${source.sourcePort}`;
				if (outputs.has(key)) continue;
				const transfer = settled.find(
					(entry) =>
						entry.sourceNodeId === source.sourceNodeId &&
						entry.sourcePort === source.sourcePort &&
						entry.state === 'emitted',
				);
				if (!transfer) continue;
				const payload = await this.repository.readEdgePayload(
					run.tenantId,
					run.id,
					transfer.edgeId,
				);
				if (payload !== undefined) outputs.set(key, payload);
			}
			const nodeInput = applyWorkflowMappings(
				baseInput,
				node.mappings ?? [],
				outputs,
			);
			const schemaId = inputSchema(node);
			const prior = state.attempts.at(-1);
			const attemptNumber =
				prior &&
				(prior.status === 'running' || prior.status === 'waiting-child')
					? prior.attempt
					: state.latestAttempt + 1;
			if (
				!prior ||
				(prior.status !== 'running' && prior.status !== 'waiting-child')
			) {
				await this.repository.startAttempt(
					{
						tenantId: run.tenantId,
						runId: run.id,
						nodeId: node.id,
						nodeType: node.type,
						attempt: attemptNumber,
						semanticGroup: `${run.id}:${node.id}`,
						sideEffectIdempotencyKey: `${run.tenantId}:${run.id}:${node.id}`,
						input: nodeInput,
						inputEvidence: safePayloadEvidence(nodeInput, schemaId, {
							schema: run.graph.schemas[schemaId] ?? {},
							permissionSnapshot: run.permissionSnapshot,
						}),
						schemaId,
						recordedAt: this.#now(),
					},
					run.actor,
					run.origin,
				);
			}
			if (jsonByteSize(nodeInput) > WORKFLOW_LIMITS.maxEnvelopeBytes) {
				await this.#failNode(
					run,
					node,
					attemptNumber,
					'WORKFLOW_INPUT_LIMIT_EXCEEDED',
				);
				return;
			}
			if (
				node.type === 'merge'
					? values.some(
							(entry) =>
								validateJsonSchema(
									entry.payload,
									run.graph.schemas[schemaId] ?? {},
								).length > 0,
						)
					: validateJsonSchema(nodeInput, run.graph.schemas[schemaId] ?? {})
							.length > 0
			) {
				await this.#failNode(
					run,
					node,
					attemptNumber,
					'WORKFLOW_INPUT_INVALID',
				);
				return;
			}
			const waiting = prior?.status === 'waiting-child' ? prior : null;
			const result = await this.#executeNode(
				run,
				node,
				nodeInput,
				attemptNumber,
				waiting?.childId ?? null,
				waiting?.childObservationDeadlineAt ?? null,
				dependencies,
				assertLease,
			);
			assertLease();
			if (!result) return;
			if (result.status !== 'succeeded') {
				const delay = result.retryable ? backoff(node, attemptNumber) : null;
				const retryAllowed =
					delay !== null &&
					node.failurePolicy?.retryOn.includes(result.code ?? '') === true;
				await this.repository.settleAttempt(
					{
						tenantId: run.tenantId,
						runId: run.id,
						nodeId: node.id,
						attempt: attemptNumber,
						status: result.status,
						outcomePort: retryAllowed
							? null
							: node.outputPorts.some((port) => port.name === 'failure')
								? 'failure'
								: null,
						...(result.output === undefined ? {} : { output: result.output }),
						outputEvidence: safePayloadEvidence(
							result.output,
							outputSchema(node, 'failure'),
							{
								schema: run.graph.schemas[outputSchema(node, 'failure')] ?? {},
								permissionSnapshot: run.permissionSnapshot,
							},
						),
						schemaId: outputSchema(node, 'failure'),
						failureCode: result.code ?? 'WORKFLOW_NODE_FAILED',
						retryClassification: result.retryable ? 'retryable' : 'permanent',
						selectedBackoffMs: retryAllowed ? delay : null,
						nextAttemptAt: retryAllowed ? this.#now() + delay : null,
						recordedAt: this.#now(),
					},
					run.actor,
					run.origin,
				);
				if (retryAllowed) return;
				if (
					node.failurePolicy?.onExhausted === 'emit-failure' &&
					result.output !== undefined
				) {
					await this.#settleEdges(
						run,
						node,
						attemptNumber,
						'failure',
						result.output,
					);
					continue;
				}
				const terminal =
					(await this.repository.getRun(run.tenantId, run.id)) ?? run;
				await this.repository.settleRun(
					run.tenantId,
					run.id,
					result.status === 'refused' ? 'refused' : 'failed',
					result.code ?? 'WORKFLOW_NODE_FAILED',
					undefined,
					safePayloadEvidence(undefined, 'workflow.output'),
					finalUsage(terminal),
					finalCost(terminal),
					this.#now(),
				);
				return;
			}
			const outcome = result.outcomePort;
			const schema = outputSchema(node, outcome);
			if (jsonByteSize(result.output) > WORKFLOW_LIMITS.maxEnvelopeBytes) {
				await this.#failNode(
					run,
					node,
					attemptNumber,
					'WORKFLOW_OUTPUT_LIMIT_EXCEEDED',
				);
				return;
			}
			if (
				validateJsonSchema(result.output, run.graph.schemas[schema] ?? {})
					.length > 0
			) {
				await this.#failNode(
					run,
					node,
					attemptNumber,
					'WORKFLOW_OUTPUT_INVALID',
				);
				return;
			}
			await this.repository.settleAttempt(
				{
					tenantId: run.tenantId,
					runId: run.id,
					nodeId: node.id,
					attempt: attemptNumber,
					status: 'succeeded',
					outcomePort: outcome || null,
					output: result.output,
					outputEvidence: safePayloadEvidence(result.output, schema, {
						schema: run.graph.schemas[schema] ?? {},
						permissionSnapshot: run.permissionSnapshot,
					}),
					schemaId: schema,
					failureCode: null,
					retryClassification: null,
					selectedBackoffMs: null,
					nextAttemptAt: null,
					recordedAt: this.#now(),
				},
				run.actor,
				run.origin,
			);
			if (node.type === 'output') {
				const terminal =
					(await this.repository.getRun(run.tenantId, run.id)) ?? run;
				await this.repository.settleRun(
					run.tenantId,
					run.id,
					'succeeded',
					null,
					result.output,
					safePayloadEvidence(result.output, schema, {
						schema: run.graph.schemas[schema] ?? {},
						permissionSnapshot: run.permissionSnapshot,
					}),
					finalUsage(terminal),
					finalCost(terminal),
					this.#now(),
				);
				return;
			}
			await this.#settleEdges(run, node, attemptNumber, outcome, result.output);
		}
	}

	async #executeNode(
		run: WorkflowRunRecord,
		node: WorkflowNodeV1,
		input: JsonValue,
		attempt: number,
		childId: string | null,
		childObservationDeadlineAt: number | null,
		dependencies: {
			readonly agents: AgentRevisionExecutionCapability;
			readonly actions: AgentActionExecutionCapability;
		},
		assertLease: () => void,
	): Promise<{
		readonly status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
		readonly outcomePort: string;
		readonly output: JsonValue;
		readonly code?: string;
		readonly retryable?: boolean;
	} | null> {
		switch (node.type) {
			case 'input':
			case 'merge':
				return { status: 'succeeded', outcomePort: 'data', output: input };
			case 'output':
				return { status: 'succeeded', outcomePort: '', output: input };
			case 'gate':
				return {
					status: 'succeeded',
					outcomePort: evaluateGate(node.expression, input) ? 'pass' : 'fail',
					output: input,
				};
			case 'validator': {
				const errors = validateJsonSchema(
					input,
					run.graph.schemas[node.schemaId] ?? {},
				);
				return {
					status: 'succeeded',
					outcomePort: errors.length === 0 ? 'pass' : 'fail',
					output:
						errors.length === 0
							? input
							: { errors: errors as unknown as JsonValue },
				};
			}
			case 'agent':
			case 'agent-decision': {
				let id = childId;
				if (!id) {
					const outputContract =
						node.type === 'agent-decision'
							? {
									kind: 'json-schema' as const,
									name: 'workflow-agent-decision',
									schema: {
										type: 'object',
										required: ['decision', 'data'],
										properties: {
											decision: { enum: ['pass', 'fail'] },
											data: {},
											reason: { type: 'string' },
										},
									},
								}
							: {
									kind: 'json-schema' as const,
									name: node.outputSchemaId,
									schema: run.graph.schemas[node.outputSchemaId] ?? {},
								};
					let accepted;
					try {
						accepted = await dependencies.agents.enqueueRevision(
							{
								agentId: node.agent.agentId,
								revision: node.agent.revision,
								input: JSON.stringify(input),
								toolGrants: node.toolGrants,
								outputContract,
								/* A provider retry is a new child execution. Recovery of the
							   same immutable workflow attempt reuses this exact key. */
								idempotencyKey: `${run.tenantId}:${run.id}:${node.id}:attempt:${attempt}`,
							},
							childContext(run),
						);
						assertLease();
					} catch (error) {
						const code = stableCapabilityCode(error, 'AGENT_RUN_REFUSED');
						return {
							status: 'refused',
							outcomePort: 'failure',
							output: { code },
							code,
						};
					}
					id = accepted.runId;
					const observationDeadlineAt = Math.min(
						run.queuedAt + WORKFLOW_LIMITS.maxLiveDurationMs,
						this.#now() + WORKFLOW_LIMITS.maxChildObservationMs,
					);
					await this.repository.markChildWaiting(
						run.tenantId,
						run.id,
						node.id,
						attempt,
						'agent',
						id,
						observationDeadlineAt,
						this.#now(),
					);
					return null;
				}
				if (
					childObservationDeadlineAt === null ||
					this.#now() >= childObservationDeadlineAt
				) {
					return {
						status: 'refused',
						outcomePort: 'failure',
						output: {
							code: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
							childRunId: id,
						},
						code: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
					};
				}
				let result;
				try {
					result = await dependencies.agents.getResult(id, childContext(run));
					assertLease();
				} catch (error) {
					const code = stableCapabilityCode(error, 'AGENT_RESULT_REFUSED');
					return {
						status: 'refused',
						outcomePort: 'failure',
						output: { code, childRunId: id },
						code,
					};
				}
				if (!result) return null;
				if (result.usage)
					await this.repository.recordAgentUsage(
						run.tenantId,
						run.id,
						id,
						result.usage,
					);
				if (result.status !== 'succeeded') {
					return {
						status: result.status === 'cancelled' ? 'cancelled' : 'failed',
						outcomePort: 'failure',
						output: {
							code: result.failureCode ?? 'AGENT_RUN_FAILED',
							childRunId: id,
						},
						code: result.failureCode ?? 'AGENT_RUN_FAILED',
						retryable: result.status === 'failed',
					};
				}
				const output = result.structuredOutput ?? result.output ?? null;
				if (node.type === 'agent-decision') {
					if (!output || typeof output !== 'object' || Array.isArray(output)) {
						return {
							status: 'refused',
							outcomePort: 'failure',
							output: { code: 'WORKFLOW_OUTPUT_INVALID' },
							code: 'WORKFLOW_OUTPUT_INVALID',
						};
					}
					const record = output as Readonly<Record<string, JsonValue>>;
					const decision = record.decision;
					if (
						(decision !== 'pass' && decision !== 'fail') ||
						!('data' in record)
					) {
						return {
							status: 'refused',
							outcomePort: 'failure',
							output: { code: 'WORKFLOW_OUTPUT_INVALID' },
							code: 'WORKFLOW_OUTPUT_INVALID',
						};
					}
					return {
						status: 'succeeded',
						outcomePort: decision,
						output: record.data!,
					};
				}
				return { status: 'succeeded', outcomePort: 'success', output };
			}
			case 'action': {
				let id = childId;
				if (!id) {
					const controller = new AbortController();
					let accepted;
					try {
						accepted = await dependencies.actions.start(
							{
								actionId: node.action.actionId,
								contractVersion: node.action.contractVersion,
								input,
								idempotencyKey: `${run.tenantId}:${run.id}:${node.id}`,
							},
							{
								...childContext(run),
								nodeRunId: `${run.id}:${node.id}:${attempt}`,
								signal: controller.signal,
							},
						);
						assertLease();
					} catch (error) {
						const code = stableCapabilityCode(
							error,
							'ACTION_EXECUTION_REFUSED',
						);
						return {
							status: 'refused',
							outcomePort: 'failure',
							output: { code },
							code,
						};
					}
					id = accepted.actionInvocationId;
					const observationDeadlineAt = Math.min(
						run.queuedAt + WORKFLOW_LIMITS.maxLiveDurationMs,
						this.#now() + WORKFLOW_LIMITS.maxChildObservationMs,
					);
					await this.repository.markChildWaiting(
						run.tenantId,
						run.id,
						node.id,
						attempt,
						'action',
						id,
						observationDeadlineAt,
						this.#now(),
					);
					return null;
				}
				if (
					childObservationDeadlineAt === null ||
					this.#now() >= childObservationDeadlineAt
				) {
					return {
						status: 'refused',
						outcomePort: 'failure',
						output: {
							code: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
							actionInvocationId: id,
						},
						code: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
					};
				}
				let result;
				try {
					result = await dependencies.actions.getResult(id, childContext(run));
					assertLease();
				} catch (error) {
					const code = stableCapabilityCode(error, 'ACTION_RESULT_REFUSED');
					return {
						status: 'refused',
						outcomePort: 'failure',
						output: { code, actionInvocationId: id },
						code,
					};
				}
				if (!result) return null;
				if (result.status !== 'succeeded') {
					return {
						status: result.status,
						outcomePort: 'failure',
						output: result.output ?? {
							code: result.code ?? 'ACTION_EXECUTION_FAILED',
							actionInvocationId: id,
						},
						code: result.code ?? 'ACTION_EXECUTION_FAILED',
						retryable: result.status === 'failed',
					};
				}
				return {
					status: 'succeeded',
					outcomePort: 'success',
					output: result.output ?? null,
				};
			}
		}
	}

	async #failNode(
		run: WorkflowRunRecord,
		node: WorkflowNodeV1,
		attempt: number,
		code: string,
	): Promise<void> {
		const actualAttempt = Math.max(1, attempt);
		await this.repository.settleAttempt(
			{
				tenantId: run.tenantId,
				runId: run.id,
				nodeId: node.id,
				attempt: actualAttempt,
				status: 'refused',
				outcomePort: null,
				outputEvidence: safePayloadEvidence(undefined, 'workflow.output'),
				schemaId: 'workflow.output',
				failureCode: code,
				retryClassification: 'permanent',
				selectedBackoffMs: null,
				nextAttemptAt: null,
				recordedAt: this.#now(),
			},
			run.actor,
			run.origin,
		);
		const terminal =
			(await this.repository.getRun(run.tenantId, run.id)) ?? run;
		await this.repository.settleRun(
			run.tenantId,
			run.id,
			'refused',
			code,
			undefined,
			safePayloadEvidence(undefined, 'workflow.output'),
			finalUsage(terminal),
			finalCost(terminal),
			this.#now(),
		);
	}

	async #settleEdges(
		run: WorkflowRunRecord,
		node: WorkflowNodeV1,
		attempt: number,
		selectedPort: string,
		output: JsonValue,
	): Promise<void> {
		for (const edge of run.graph.edges.filter(
			(entry) => entry.source.nodeId === node.id,
		)) {
			const emitted = edge.source.port === selectedPort;
			const schemaId = outputSchema(node, edge.source.port);
			await this.repository.settleEdge({
				tenantId: run.tenantId,
				runId: run.id,
				transfer: {
					edgeId: edge.id,
					sourceNodeId: node.id,
					sourcePort: edge.source.port,
					sourceAttempt: attempt,
					targetNodeId: edge.target.nodeId,
					targetPort: edge.target.port,
					state: emitted ? 'emitted' : 'closed',
					reason: emitted ? null : `outcome:${selectedPort || 'none'}`,
					evidence: safePayloadEvidence(
						emitted ? output : undefined,
						schemaId,
						{
							schema: run.graph.schemas[schemaId] ?? {},
							permissionSnapshot: run.permissionSnapshot,
						},
					),
					settledAt: this.#now(),
				},
				...(emitted ? { payload: output } : {}),
			});
		}
	}

	async #skip(
		run: WorkflowRunRecord,
		node: WorkflowNodeV1,
		reason: string,
	): Promise<void> {
		await this.repository.markNodeSkipped(
			run.tenantId,
			run.id,
			node.id,
			reason,
			this.#now(),
			run.actor,
			run.origin,
		);
		for (const edge of run.graph.edges.filter(
			(entry) => entry.source.nodeId === node.id,
		)) {
			const schemaId = outputSchema(node, edge.source.port);
			await this.repository.settleEdge({
				tenantId: run.tenantId,
				runId: run.id,
				transfer: {
					edgeId: edge.id,
					sourceNodeId: node.id,
					sourcePort: edge.source.port,
					sourceAttempt: null,
					targetNodeId: edge.target.nodeId,
					targetPort: edge.target.port,
					state: 'skipped',
					reason: 'source-skipped',
					evidence: safePayloadEvidence(undefined, schemaId),
					settledAt: this.#now(),
				},
			});
		}
	}
}
