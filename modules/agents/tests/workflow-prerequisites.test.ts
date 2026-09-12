import type { DatabaseAdapterLease } from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentProvider,
	type AgentTool,
	type AgentToolAuthorizationRequest,
} from '@flowdular/harness';
import { AGENT_PERMISSIONS } from '../src/acl/permissions.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import {
	AgentActionCapabilityError,
	createAgentActionExecutionRuntime,
	type AgentActionRuntime,
} from '../src/server/action-execution.ts';
import { createAgentRevisionExecutionCapability } from '../src/server/run-execution.ts';
import { createAgentRuntime } from '../src/server/runtime.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-workflow';
const actor = {
	kind: 'user',
	id: 'owner-workflow',
	label: 'Workflow owner',
} as const;

function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(() => void tick(), 10);
		};
		void tick();
	});
}

const agentInput: CreateAgentInput = {
	key: 'workflow-agent',
	name: 'Workflow agent',
	description: 'Executes one exact retained revision.',
	instructions: 'Return the original workflow decision.',
	provider: 'structured-provider',
	model: 'structured-model',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 5_000,
	temperature: 0,
	maxOutputTokens: 1_024,
	status: 'draft',
};

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const workers: AgentWorker[] = [];
const actionRuntimes: AgentActionRuntime[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const runtime of actionRuntimes.splice(0)) await runtime.dispose();
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

function trackedWorker(harness: AgentHarness, workerId: string): AgentWorker {
	const worker = new AgentWorker(database.repository, harness, {
		workerId,
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	return worker;
}

function trackedActionRuntime(
	tools: readonly AgentTool[],
	options: Parameters<typeof createAgentActionExecutionRuntime>[2],
): AgentActionRuntime {
	const runtime = createAgentActionExecutionRuntime(
		database.repository,
		tools,
		options,
	);
	actionRuntimes.push(runtime);
	return runtime;
}

describe('workflow agent execution capability', () => {
	it('keeps both background workers stopped until the composition starts', async () => {
		const runtime = createAgentRuntime({
			databases: database.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [new LocalSimulationProvider()],
			providerHostAllowlist: new Set(),
			providerReadinessTtlMs: 10_000,
			providerReadinessTimeoutMs: 1_000,
			runGrantTtlMs: 1_000,
			environment: { NODE_ENV: 'test' },
		});

		try {
			expect((await runtime.workerStatus()).online).toBe(false);
			void runtime.service();
			expect((await runtime.workerStatus()).online).toBe(false);
			runtime.start();
			await waitFor(async () => (await runtime.workerStatus()).online);
			runtime.stop();
			void runtime.providerService();
			expect((await runtime.workerStatus()).online).toBe(false);
		} finally {
			await runtime.dispose();
		}
	});

	it('executes an immutable exact revision with structured output and durable observation', async () => {
		let executedRevision = 0;
		let executedInstructions = '';
		let executedOutputContract = 'missing';
		const provider: AgentProvider = {
			id: 'structured-provider',
			capabilities: { structuredOutput: true },
			execute: async (context) => {
				executedRevision = context.request.definition.revision;
				executedInstructions = context.request.definition.instructions;
				executedOutputContract =
					context.request.outputContract?.kind ?? 'missing';
				return {
					output: '{"decision":"approved"}',
					structuredOutput: { decision: 'approved' },
					usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
					finishReason: 'stop',
				};
			},
		};
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [provider] });
		const worker = trackedWorker(harness, 'worker:workflow');
		const service = new AgentService(repository, harness, worker);
		const created = await service.createAgent(tenantId, actor.id, agentInput);
		const active = await service.updateAgent(tenantId, created.id, actor.id, {
			...agentInput,
			status: 'active',
			expectedRevision: created.revision,
		});
		await service.updateAgent(tenantId, active.id, actor.id, {
			...agentInput,
			instructions: 'Return a later and different decision.',
			status: 'active',
			expectedRevision: active.revision,
		});

		const capability = createAgentRevisionExecutionCapability(service);
		const context = {
			tenantId,
			workflowRunId: 'workflow-run-1',
			actor,
			permissionSnapshot: [
				AGENT_PERMISSIONS.definitionsRead,
				AGENT_PERMISSIONS.runsRead,
				AGENT_PERMISSIONS.runsExecute,
			],
		};
		expect(
			await capability.getRevision(active.id, active.revision, context),
		).toMatchObject({
			revision: 2,
			status: 'active',
			supportsStructuredOutput: true,
		});
		expect(
			(await capability.listRevisions(context)).map(({ revision, status }) => ({
				revision,
				status,
			})),
		).toEqual([
			{ revision: 3, status: 'active' },
			{ revision: 2, status: 'active' },
		]);
		expect(await capability.getRevision(active.id, 1, context)).toBeNull();
		const request = {
			agentId: active.id,
			revision: active.revision,
			input: 'Decide invoice 42.',
			toolGrants: [],
			outputContract: {
				kind: 'json-schema',
				name: 'InvoiceDecision',
				schema: {
					type: 'object',
					required: ['decision'],
					properties: { decision: { type: 'string' } },
					additionalProperties: false,
				},
			} as const,
			idempotencyKey: 'workflow-run-1:node-1:attempt-1',
		};
		const accepted = await capability.enqueueRevision(request, context);
		expect(accepted.created).toBe(true);
		expect(await capability.enqueueRevision(request, context)).toEqual({
			runId: accepted.runId,
			created: false,
		});
		await expect(
			capability.enqueueRevision(
				{ ...request, input: 'A different request.' },
				context,
			),
		).rejects.toMatchObject({ code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT' });
		await expect(
			capability.enqueueRevision(
				{
					...request,
					idempotencyKey: 'workflow-run-1:invalid-contract',
					outputContract: {
						kind: 'json-schema',
						name: 'Invalid',
						schema: { type: 'object', properties: undefined } as never,
					},
				},
				context,
			),
		).rejects.toMatchObject({ code: 'INVALID_OUTPUT_CONTRACT' });

		await worker.start();
		await waitFor(
			async () =>
				(await capability.getResult(accepted.runId, context))?.status ===
				'succeeded',
		);
		expect(executedRevision).toBe(2);
		expect(executedInstructions).toContain('original workflow decision');
		expect(executedInstructions).not.toContain('later and different');
		expect(executedOutputContract).toBe('json-schema');
		expect(await capability.getResult(accepted.runId, context)).toMatchObject({
			structuredOutput: { decision: 'approved' },
			status: 'succeeded',
		});
		expect(
			(await capability.readEvents(accepted.runId, 0, context)).at(-1)?.type,
		).toBe('run.completed');
		expect(
			await capability.getResult(accepted.runId, {
				...context,
				tenantId: 'tenant-other',
			}),
		).toBeNull();
		const otherActorContext = {
			...context,
			actor: { kind: 'user', id: 'another-owner', label: 'Another owner' },
		} as const;
		expect(
			await capability.getResult(accepted.runId, otherActorContext),
		).toBeNull();
		expect(
			await capability.readEvents(accepted.runId, 0, otherActorContext),
		).toEqual([]);
		worker.stop();
	});

	it('does not let another workflow actor cancel a queued child run', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
		});
		const worker = trackedWorker(harness, 'worker:actor-boundary');
		const service = new AgentService(repository, harness, worker);
		const created = await service.createAgent(tenantId, actor.id, {
			...agentInput,
			provider: 'local-simulation',
			model: 'deterministic-v1',
		});
		const active = await service.updateAgent(tenantId, created.id, actor.id, {
			...agentInput,
			provider: 'local-simulation',
			model: 'deterministic-v1',
			status: 'active',
			expectedRevision: created.revision,
		});
		const capability = createAgentRevisionExecutionCapability(service);
		const serviceActor = {
			kind: 'service',
			id: 'workflow-service',
			label: 'Workflow service',
			configuredBy: actor,
		} as const;
		const context = {
			tenantId,
			workflowRunId: 'workflow-run-actor-boundary',
			actor: serviceActor,
			permissionSnapshot: [AGENT_PERMISSIONS.runsExecute],
		};
		const accepted = await capability.enqueueRevision(
			{
				agentId: active.id,
				revision: active.revision,
				input: 'Stay queued.',
				toolGrants: [],
				outputContract: { kind: 'text' },
				idempotencyKey: 'workflow-run-actor-boundary:node-1',
			},
			context,
		);
		expect(
			(await repository.getRun(tenantId, accepted.runId))?.requestedActor,
		).toEqual(serviceActor);
		await expect(
			capability.enqueueRevision(
				{
					agentId: active.id,
					revision: active.revision,
					input: 'Stay queued.',
					toolGrants: [],
					outputContract: { kind: 'text' },
					idempotencyKey: 'workflow-run-actor-boundary:node-1',
				},
				{
					...context,
					actor: {
						...serviceActor,
						configuredBy: {
							kind: 'user',
							id: 'another-owner',
							label: 'Another owner',
						},
					},
				},
			),
		).rejects.toMatchObject({ code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT' });

		expect(
			await capability.requestCancel(accepted.runId, {
				...context,
				actor: {
					...serviceActor,
					configuredBy: {
						kind: 'user',
						id: 'another-owner',
						label: 'Another owner',
					},
				},
			}),
		).toBe(false);
		expect((await repository.getRun(tenantId, accepted.runId))?.status).toBe(
			'queued',
		);
	});

	it('requires the capability-specific RBAC scopes', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [] });
		const worker = trackedWorker(harness, 'worker:denied');
		const capability = createAgentRevisionExecutionCapability(
			new AgentService(repository, harness, worker),
		);
		await expect(
			capability.getRevision('agent-1', 1, {
				tenantId,
				workflowRunId: 'workflow-run-1',
				actor,
				permissionSnapshot: [],
			}),
		).rejects.toThrow('lacks permission');
	});
});

function workflowAction(overrides: Partial<AgentTool> = {}): AgentTool {
	return {
		id: 'parties.customer.lookup',
		transport: 'api',
		target: 'parties.records.get',
		description: 'Look up one customer.',
		requiredPermissions: ['parties.records.read'],
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'string' } },
			additionalProperties: false,
		},
		contractVersion: 1,
		outputSchema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' } },
			additionalProperties: false,
		},
		risk: 'read',
		idempotency: 'required',
		cancellation: 'cooperative',
		timeoutMs: 1_000,
		execute: async () => ({ name: 'Ada' }),
		...overrides,
	};
}

const authorizeWorkflowRead = (_request: AgentToolAuthorizationRequest) => [
	'parties.records.read',
];

describe('versioned workflow action capability', () => {
	it('refuses an unsafe action lease configuration', async () => {
		expect(() =>
			createAgentActionExecutionRuntime(
				database.repository,
				[workflowAction()],
				{
					workerId: 'action-worker:invalid-lease',
					leaseMs: 999,
					authorizeToolAccess: authorizeWorkflowRead,
				},
			),
		).toThrow('between 1000 and 300000 ms');
	});

	it('excludes invalid action schemas and returns defensive catalog copies', async () => {
		const cyclicSchema: Record<string, unknown> = { type: 'object' };
		cyclicSchema.self = cyclicSchema;
		const runtime = trackedActionRuntime(
			[
				workflowAction(),
				workflowAction({
					id: 'parties.customer.invalid',
					outputSchema: cyclicSchema,
				}),
			],
			{
				workerId: 'action-worker:catalog',
				leaseMs: 1_000,
				authorizeToolAccess: authorizeWorkflowRead,
			},
		);
		const first = await runtime.capability.listWorkflowActions();
		expect(first.map((action) => action.id)).toEqual([
			'parties.customer.lookup',
		]);
		(first[0]!.inputSchema as Record<string, unknown>).type = 'array';
		(first[0]!.requiredPermissions as string[]).push('unexpected.permission');

		const second = await runtime.capability.listWorkflowActions();
		expect(second[0]?.inputSchema.type).toBe('object');
		expect(second[0]?.requiredPermissions).toEqual(['parties.records.read']);
	});

	it('lists only complete safe contracts and executes them idempotently under RBAC', async () => {
		const execute = vi.fn(async () => ({ name: 'Ada' }));
		const authorize = vi.fn(authorizeWorkflowRead);
		const repository = database.repository;
		const runtime = trackedActionRuntime(
			[
				workflowAction({ execute }),
				workflowAction({ id: 'unsafe.external', risk: 'external' }),
			],
			{
				workerId: 'action-worker:test',
				leaseMs: 1_000,
				authorizeToolAccess: authorize,
			},
		);
		expect(
			(await runtime.capability.listWorkflowActions()).map((item) => item.id),
		).toEqual(['parties.customer.lookup']);
		const controller = new AbortController();
		const context = {
			tenantId,
			workflowRunId: 'workflow-run-2',
			nodeRunId: 'node-run-1',
			actor: {
				kind: 'service',
				id: 'schedule-1',
				label: 'Daily customer check',
				configuredBy: actor,
			} as const,
			permissionSnapshot: ['parties.records.read'],
			signal: controller.signal,
		};
		await expect(
			runtime.capability.start(
				{
					actionId: 'parties.customer.lookup',
					contractVersion: 1,
					input: { id: 'customer-1' },
					idempotencyKey: 'workflow-run-2:denied',
				},
				{ ...context, permissionSnapshot: [] },
			),
		).rejects.toMatchObject({ code: 'ACTION_PERMISSION_DENIED' });

		const request = {
			actionId: 'parties.customer.lookup',
			contractVersion: 1,
			input: { id: 'customer-1' },
			idempotencyKey: 'workflow-run-2:node-run-1',
		} as const;
		const accepted = await runtime.capability.start(request, context);
		expect(
			await repository.getAction(tenantId, accepted.actionInvocationId),
		).toMatchObject({
			actor: { kind: 'service', id: 'schedule-1' },
			authorizationSubject: { kind: 'user', id: actor.id },
		});
		expect(await runtime.capability.start(request, context)).toEqual({
			actionInvocationId: accepted.actionInvocationId,
			created: false,
		});
		await expect(
			runtime.capability.start(
				{ ...request, input: { id: 'customer-2' } },
				context,
			),
		).rejects.toBeInstanceOf(AgentActionCapabilityError);

		runtime.start();
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'succeeded',
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(
			authorize.mock.calls.every(
				([request]) =>
					request.actor.kind === 'user' && request.actor.id === actor.id,
			),
		).toBe(true);
		expect(
			await runtime.capability.getResult(accepted.actionInvocationId, context),
		).toMatchObject({ status: 'succeeded', output: { name: 'Ada' } });
		expect(
			await runtime.capability.getResult(accepted.actionInvocationId, {
				tenantId,
				workflowRunId: context.workflowRunId,
				actor: { kind: 'user', id: 'another-user', label: 'Another user' },
				permissionSnapshot: ['parties.records.read'],
			}),
		).toBeNull();
		expect(
			await runtime.capability.getResult(accepted.actionInvocationId, {
				tenantId,
				workflowRunId: context.workflowRunId,
				actor: {
					...context.actor,
					configuredBy: {
						kind: 'user',
						id: 'another-owner',
						label: 'Another owner',
					},
				},
				permissionSnapshot: ['parties.records.read'],
			}),
		).toBeNull();
		expect(
			await runtime.capability.getResult(accepted.actionInvocationId, {
				tenantId,
				workflowRunId: context.workflowRunId,
				actor: context.actor,
				permissionSnapshot: [],
			}),
		).toBeNull();
		const audit = await repository.listAuditEvents(tenantId, 20);
		expect(audit.map((event) => event.action)).toContain(
			'agent-action.succeeded',
		);
		expect(JSON.stringify(audit)).not.toContain('customer-1');
	});

	it('refuses execution when the initiating actor loses action permission after enqueue', async () => {
		let livePermissions = ['parties.records.read'];
		const execute = vi.fn(async () => ({ name: 'Ada' }));
		const repository = database.repository;
		const runtime = trackedActionRuntime([workflowAction({ execute })], {
			workerId: 'action-worker:revoked',
			leaseMs: 1_000,
			authorizeToolAccess: () => livePermissions,
		});
		const accepted = await runtime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-revoked:node-1',
			},
			{
				tenantId,
				workflowRunId: 'workflow-run-revoked',
				nodeRunId: 'node-1',
				actor,
				permissionSnapshot: ['parties.records.read'],
				signal: new AbortController().signal,
			},
		);
		livePermissions = [];
		runtime.start();
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'failed',
		);

		expect(execute).not.toHaveBeenCalled();
		expect(
			await repository.getAction(tenantId, accepted.actionInvocationId),
		).toMatchObject({ code: 'ACTION_PERMISSION_REVOKED' });
	});

	it('aborts in-flight action work on dispose and leaves it recoverable', async () => {
		let aborted = false;
		const repository = database.repository;
		const runtime = trackedActionRuntime(
			[
				workflowAction({
					execute: (_input, context) =>
						new Promise((_, reject) => {
							context.signal.addEventListener('abort', () => {
								aborted = true;
								reject(new Error('aborted'));
							});
						}),
				}),
			],
			{
				workerId: 'action-worker:shutdown',
				leaseMs: 1_000,
				authorizeToolAccess: authorizeWorkflowRead,
			},
		);
		const controller = new AbortController();
		const context = {
			tenantId,
			workflowRunId: 'workflow-run-3',
			nodeRunId: 'node-run-1',
			actor,
			permissionSnapshot: ['parties.records.read'],
			signal: controller.signal,
		};
		const accepted = await runtime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-3:node-run-1',
			},
			context,
		);
		runtime.start();
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'running',
		);

		await runtime.dispose();

		expect(aborted).toBe(true);
		expect(
			(await repository.getAction(tenantId, accepted.actionInvocationId))
				?.status,
		).toBe('running');
	});

	it('disposes promptly when an action ignores its abort signal', async () => {
		const repository = database.repository;
		const runtime = trackedActionRuntime(
			[
				workflowAction({
					execute: () => new Promise(() => {}),
				}),
			],
			{
				workerId: 'action-worker:non-cooperative',
				leaseMs: 1_000,
				authorizeToolAccess: authorizeWorkflowRead,
			},
		);
		const accepted = await runtime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-non-cooperative:node-run-1',
			},
			{
				tenantId,
				workflowRunId: 'workflow-run-non-cooperative',
				nodeRunId: 'node-run-1',
				actor,
				permissionSnapshot: ['parties.records.read'],
				signal: new AbortController().signal,
			},
		);
		runtime.start();
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'running',
		);

		await runtime.dispose();

		expect(
			(await repository.getAction(tenantId, accepted.actionInvocationId))
				?.status,
		).toBe('running');
	});

	/* The drain loop fired every invocation of a routing page at once. The runner
	   holds that same ceiling, so the invocation after a full page is not even
	   claimed until one of the eight in flight is settled. */
	it('performs a page of invocations at once and leaves the next one queued', async () => {
		const repository = database.repository;
		const entered: string[] = [];
		const gates = new Map<string, () => void>();
		const runtime = trackedActionRuntime(
			[
				workflowAction({
					timeoutMs: 30_000,
					execute: async (input) => {
						const id = (input as { readonly id: string }).id;
						entered.push(id);
						await new Promise<void>((resolve) => gates.set(id, resolve));
						return { name: id };
					},
				}),
			],
			{
				workerId: 'action-worker:concurrent',
				leaseMs: 5_000,
				authorizeToolAccess: authorizeWorkflowRead,
			},
		);
		const accepted: string[] = [];
		for (let index = 0; index < 9; index += 1) {
			accepted.push(
				(
					await runtime.capability.start(
						{
							actionId: 'parties.customer.lookup',
							contractVersion: 1,
							input: { id: `customer-${index}` },
							idempotencyKey: `workflow-run-concurrent:node-${index}`,
						},
						{
							tenantId,
							workflowRunId: 'workflow-run-concurrent',
							nodeRunId: `node-${index}`,
							actor,
							permissionSnapshot: ['parties.records.read'],
							signal: new AbortController().signal,
						},
					)
				).actionInvocationId,
			);
		}

		runtime.start();
		await waitFor(() => entered.length >= 8);
		/* Long enough that a ninth would have started if nothing bounded the pool. */
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(entered).toHaveLength(8);

		gates.get(entered[0]!)!();
		await waitFor(() => entered.length === 9);
		for (const release of gates.values()) release();
		await waitFor(async () => {
			const rows = await Promise.all(
				accepted.map((id) => repository.getAction(tenantId, id)),
			);
			return rows.every((row) => row?.status === 'succeeded');
		});
	});

	it('refuses non-JSON action input with a stable error before persistence', async () => {
		const repository = database.repository;
		const runtime = trackedActionRuntime([workflowAction()], {
			workerId: 'action-worker:invalid-input',
			leaseMs: 1_000,
			authorizeToolAccess: authorizeWorkflowRead,
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		await expect(
			runtime.capability.start(
				{
					actionId: 'parties.customer.lookup',
					contractVersion: 1,
					input: cyclic as never,
					idempotencyKey: 'workflow-run-4:invalid-input',
				},
				{
					tenantId,
					workflowRunId: 'workflow-run-4',
					nodeRunId: 'node-run-1',
					actor,
					permissionSnapshot: ['parties.records.read'],
					signal: new AbortController().signal,
				},
			),
		).rejects.toMatchObject({ code: 'ACTION_INPUT_INVALID' });
		expect(
			await repository.findActionByIdempotencyKey(
				tenantId,
				'workflow-run-4:invalid-input',
			),
		).toBeNull();
	});

	it('cancels an invocation when the caller aborts during enqueue', async () => {
		const repository = database.repository;
		const runtime = trackedActionRuntime([workflowAction()], {
			workerId: 'action-worker:enqueue-cancel',
			leaseMs: 1_000,
			authorizeToolAccess: authorizeWorkflowRead,
		});
		const controller = new AbortController();
		const enqueue = repository.enqueueAction.bind(repository);
		vi.spyOn(repository, 'enqueueAction').mockImplementation(
			(invocation, audit) => {
				const accepted = enqueue(invocation, audit);
				controller.abort('workflow-cancelled');
				return accepted;
			},
		);

		const accepted = await runtime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-5:enqueue-cancel',
			},
			{
				tenantId,
				workflowRunId: 'workflow-run-5',
				nodeRunId: 'node-run-1',
				actor,
				permissionSnapshot: ['parties.records.read'],
				signal: controller.signal,
			},
		);

		/* The abort listener settles the row on its own promise chain. */
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'cancelled',
		);
		expect(
			(await repository.listAuditEvents(tenantId, 10)).map(
				(event) => event.action,
			),
		).toContain('agent-action.cancelled');
	});

	it('audits a recovered action whose contract is no longer available', async () => {
		const repository = database.repository;
		const acceptingRuntime = trackedActionRuntime([workflowAction()], {
			workerId: 'action-worker:before-restart',
			leaseMs: 1_000,
			authorizeToolAccess: authorizeWorkflowRead,
		});
		const accepted = await acceptingRuntime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-6:missing-contract',
			},
			{
				tenantId,
				workflowRunId: 'workflow-run-6',
				nodeRunId: 'node-run-1',
				actor,
				permissionSnapshot: ['parties.records.read'],
				signal: new AbortController().signal,
			},
		);
		await acceptingRuntime.dispose();

		const recoveryRuntime = trackedActionRuntime([], {
			workerId: 'action-worker:after-restart',
			leaseMs: 1_000,
			authorizeToolAccess: authorizeWorkflowRead,
		});
		recoveryRuntime.start();
		await waitFor(
			async () =>
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status === 'failed',
		);
		expect(
			(await repository.listAuditEvents(tenantId, 10))
				.filter((event) => event.subjectId === accepted.actionInvocationId)
				.map((event) => event.action),
		).toEqual([
			'agent-action.failed',
			'agent-action.claimed',
			'agent-action.queued',
		]);
	});

	it('contains a background settlement failure instead of leaking a rejection', async () => {
		const repository = database.repository;
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
		const runtime = trackedActionRuntime(
			[
				workflowAction({
					execute: async () => {
						await owner.database.execute({
							text: `CREATE TRIGGER fail_action_audit
							       BEFORE INSERT ON agent_audit_events_v4
							       FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('audit unavailable')`,
						});
						throw new Error('target failed');
					},
				}),
			],
			{
				workerId: 'action-worker:settlement-failure',
				leaseMs: 1_000,
				authorizeToolAccess: authorizeWorkflowRead,
			},
		);
		const accepted = await runtime.capability.start(
			{
				actionId: 'parties.customer.lookup',
				contractVersion: 1,
				input: { id: 'customer-1' },
				idempotencyKey: 'workflow-run-7:settlement-failure',
			},
			{
				tenantId,
				workflowRunId: 'workflow-run-7',
				nodeRunId: 'node-run-1',
				actor,
				permissionSnapshot: ['parties.records.read'],
				signal: new AbortController().signal,
			},
		);
		runtime.start();
		try {
			await waitFor(() => reported.mock.calls.length > 0);
			expect(
				(await repository.getAction(tenantId, accepted.actionInvocationId))
					?.status,
			).toBe('running');
			expect(
				(await repository.listAuditEvents(tenantId, 20)).some(
					(event) => event.action === 'agent-action.failed',
				),
			).toBe(false);
			expect(reported.mock.calls[0]?.[0]).toContain(
				'worker failed to settle action',
			);
		} finally {
			await owner.database.execute({
				text: 'DROP TRIGGER IF EXISTS fail_action_audit ON agent_audit_events_v4',
			});
		}
	});
});
