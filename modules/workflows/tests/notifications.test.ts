import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
	createPlatformCapabilityRegistry,
	serviceActor,
	userActor,
	type Actor,
	type PlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	publishRunOutcome,
	type NotificationPublishInput,
	type NotificationPublisher,
} from '../src/services/notifications.ts';
import { safePayloadEvidence } from '../src/services/payload-codec.ts';
import type {
	WorkflowRunRecord,
	WorkflowsRepository,
} from '../src/services/repository.ts';
import type { WorkflowsService } from '../src/services/workflows-service.ts';
import {
	createWorkflowsRuntime,
	type WorkflowsRuntime,
} from '../src/server/runtime.ts';
import {
	createWorkflowsTestRuntime,
	openWorkflowsTestRepository,
} from './support/database.ts';

const tenantId = 'tenant-notify';
const member = 'member-notify';
const actor = userActor({
	accountId: member,
	email: 'member-notify@example.com',
});
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
	'agents.definitions.read',
	'agents.runs.read',
	'agents.runs.execute',
];

const schema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
} as const;

function directGraph(): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
			},
			{
				id: 'output.done',
				label: 'Output',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.done',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'output.done', port: 'input' },
			},
		],
		schemas: { 'schema.data': schema },
		layout: { 'input.start': { x: 0, y: 0 }, 'output.done': { x: 300, y: 0 } },
	};
}

function agentGraph(): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
			},
			{
				id: 'agent.process',
				label: 'Agent',
				type: 'agent',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.data' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				agent: { agentId: 'agent-1', revision: 3 },
				toolGrants: [],
				outputSchemaId: 'schema.data',
				failurePolicy: {
					maxAttempts: 1,
					retryOn: [],
					backoff: { kind: 'fixed', initialMs: 1, maximumMs: 1 },
					onExhausted: 'fail-run',
				},
			},
			{
				id: 'output.success',
				label: 'Success',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
			{
				id: 'output.failure',
				label: 'Failure',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.error' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.input',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'agent.process', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'agent.process', port: 'success' },
				target: { nodeId: 'output.success', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'agent.process', port: 'failure' },
				target: { nodeId: 'output.failure', port: 'input' },
			},
		],
		schemas: {
			'schema.data': schema,
			'schema.error': { type: 'object' },
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'agent.process': { x: 300, y: 0 },
			'output.success': { x: 600, y: 0 },
			'output.failure': { x: 600, y: 200 },
		},
	};
}

/** The agents.core capabilities a live run needs before it may be published. */
function agentDependencies(outcome: 'succeeded' | 'failed') {
	const agents: AgentRevisionExecutionCapability = {
		listRevisions: async () => [
			{
				agentId: 'agent-1',
				revision: 3,
				name: 'Agent',
				status: 'active',
				supportsStructuredOutput: true,
				allowedTools: [],
			},
		],
		getRevision: async () => ({
			agentId: 'agent-1',
			revision: 3,
			name: 'Agent',
			status: 'active',
			supportsStructuredOutput: true,
			allowedTools: [],
		}),
		enqueueRevision: async (request) => ({
			runId: `child:${request.idempotencyKey}`,
			created: true,
		}),
		readEvents: async () => [],
		getResult: async (runId) =>
			outcome === 'succeeded'
				? {
						runId,
						status: 'succeeded',
						output: null,
						structuredOutput: { name: 'Ada' },
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
						failureCode: null,
						completedAt: Date.now(),
					}
				: {
						runId,
						status: 'failed',
						output: null,
						structuredOutput: null,
						usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
						failureCode: 'AGENT_EXECUTION_FAILED',
						completedAt: Date.now(),
					},
		requestCancel: async () => true,
	};
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: async () => [],
		start: async () => ({ actionInvocationId: 'action-1', created: true }),
		getResult: async () => null,
		requestCancel: async (actionInvocationId) => ({
			actionInvocationId,
			state: 'acknowledged',
		}),
	};
	return { agents, actions };
}

/** Records what workflows.core asked notifications.core to publish. */
function recordingPublisher(options: { readonly throws?: boolean } = {}) {
	const calls: NotificationPublishInput[] = [];
	const publisher: NotificationPublisher = {
		publish: async (input) => {
			calls.push(input);
			if (options.throws) throw new Error('The inbox is unavailable.');
			return { inboxItemIds: ['inbox-1'], deliveryIds: [] };
		},
	};
	return { calls, publisher };
}

function registryWith(
	outcome: 'succeeded' | 'failed',
	publisher?: NotificationPublisher,
): PlatformCapabilityRegistry {
	const registry = createPlatformCapabilityRegistry();
	const fake = agentDependencies(outcome);
	registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
	registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
	if (publisher) registry.register(NOTIFICATIONS_PUBLISH_CAPABILITY, publisher);
	return registry;
}

const runtimes: WorkflowsRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	vi.restoreAllMocks();
});

function trackedRuntime(capabilities: PlatformCapabilityRegistry) {
	const runtime = createWorkflowsTestRuntime({
		capabilities,
		payloadKey: Buffer.alloc(32, 7),
		cursorKey: Buffer.alloc(32, 8),
		worker: { pollMs: 250, leaseMs: 5_000 },
	});
	runtimes.push(runtime);
	return runtime;
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeout = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for workflow state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** A published revision 2, the shape every run in this file starts from. */
async function publishedWorkflow(
	service: WorkflowsService,
	key: string,
	graph: WorkflowGraphV1,
): Promise<string> {
	const created = await service.create(
		tenantId,
		{ key, name: 'Order intake', description: '' },
		actor,
	);
	await service.update(
		tenantId,
		{
			workflowId: created.definition.id,
			expectedRevision: 1,
			name: 'Order intake',
			description: '',
			graph,
		},
		actor,
	);
	await service.publish(tenantId, created.definition.id, 2, actor, permissions);
	return created.definition.id;
}

async function runToTerminal(
	runtime: WorkflowsRuntime,
	options: {
		readonly key: string;
		readonly graph: WorkflowGraphV1;
		readonly actor?: Actor;
	},
) {
	const service = await runtime.service();
	await publishedWorkflow(service, options.key, options.graph);
	runtime.start();
	const accepted = await service.enqueue(
		{
			workflowKey: options.key,
			input: { name: 'Ada' },
			idempotencyKey: `${options.key}:1`,
		},
		{
			tenantId,
			actor: options.actor ?? actor,
			origin: { kind: 'manual' } as const,
			permissionSnapshot: permissions,
		},
	);
	await waitFor(async () => {
		const status = (await service.getRun(tenantId, accepted.runId))?.status;
		return (
			status === 'succeeded' || status === 'failed' || status === 'refused'
		);
	});
	return (await service.getRun(tenantId, accepted.runId))!;
}

/** The console lines about one run, so unrelated worker output cannot pass. */
function mentioning(spy: MockInstance, runId: string) {
	return spy.mock.calls.filter((call) => String(call[0]).includes(runId));
}

/* Settling is durable and the publish is advisory, so a settled run may be
   visible before its notification was handed over. */
async function waitForCalls(
	calls: readonly NotificationPublishInput[],
	expected: number,
) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (calls.length >= expected) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('WORKFLOWS-NOTIFY-RUN', () => {
	it('publishes one workflow-run-completed notification to the member who started the run', async () => {
		const { calls, publisher } = recordingPublisher();
		const runtime = trackedRuntime(registryWith('succeeded', publisher));

		const run = await runToTerminal(runtime, {
			key: 'notify-direct',
			graph: directGraph(),
		});
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tenantId,
			kind: 'workflow-run-completed',
			sourceModule: 'workflows.core',
			sourceRef: run.id,
			recipients: [member],
		});
		expect(calls[0]!.title).toBe('Workflow Order intake finished');
	});

	it('publishes nothing for a run that settles as cancelled', async () => {
		const { calls, publisher } = recordingPublisher();
		const runtime = trackedRuntime(registryWith('succeeded', publisher));
		const service = await runtime.service();
		await publishedWorkflow(service, 'notify-cancel', directGraph());
		const accepted = await service.enqueue(
			{
				workflowKey: 'notify-cancel',
				input: { name: 'Ada' },
				idempotencyKey: 'notify-cancel:1',
			},
			{
				tenantId,
				actor,
				origin: { kind: 'manual' } as const,
				permissionSnapshot: permissions,
			},
		);
		/* Cancelled before the worker claims it, so the cancellation is the only
		   terminal transition the worker makes for this run. */
		await service.cancel(tenantId, accepted.runId, actor);
		runtime.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, accepted.runId))?.status ===
				'cancelled',
		);
		/* Stopping resolves once the drain that settled the run returned, so a
		   publish it made would already be recorded. */
		await runtime.stop();

		expect(calls).toHaveLength(0);
	});

	it('publishes nothing when the worker settles a simulated run', async () => {
		const { calls, publisher } = recordingPublisher();
		const embedded = await openWorkflowsTestRepository();
		let claimable: WorkflowRunRecord | null = null;
		/* The claim poll takes live runs only, so a simulated row reaches the
		   worker only through a repository that hands it one. Every other call,
		   including the settle the publish decision reads, stays the real one. */
		const repository = new Proxy(embedded.repository, {
			get(target, property) {
				if (property === 'claimNext') {
					return async () => {
						const next = claimable;
						claimable = null;
						return next;
					};
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as WorkflowsRepository;
		const runtime = createWorkflowsRuntime({
			databases: embedded.databases,
			repository,
			capabilities: registryWith('succeeded', publisher),
			worker: { pollMs: 250, leaseMs: 60_000 },
		});
		try {
			const service = await runtime.service();
			const workflowId = await publishedWorkflow(
				service,
				'notify-simulate',
				directGraph(),
			);
			const simulated = await service.simulate(
				{ workflowId, input: { name: 'Ada' }, fixtures: [] },
				{
					tenantId,
					actor,
					origin: { kind: 'manual' } as const,
					permissionSnapshot: permissions,
				},
			);
			const settled = (await embedded.repository.getRun(
				tenantId,
				simulated.run.id,
			))!;
			const queued = await embedded.repository.createRun({
				run: {
					...settled,
					id: randomUUID(),
					status: 'queued',
					startedAt: null,
					completedAt: null,
					durationMs: null,
					completedNodes: 0,
					failureCode: null,
				},
				input: { name: 'Ada' },
				inputEvidence: safePayloadEvidence({ name: 'Ada' }, 'schema.data'),
			});
			claimable = queued;
			runtime.start();
			await waitFor(
				async () =>
					(await embedded.repository.getRun(tenantId, queued.id))?.status ===
					'succeeded',
			);
			await runtime.stop();

			expect(calls).toHaveLength(0);
		} finally {
			await runtime.dispose();
			await embedded.dispose();
		}
	});

	it('clamps every bounded field before the publish leaves workflows.core', async () => {
		const { calls, publisher } = recordingPublisher();

		await publishRunOutcome(() => publisher, {
			tenantId,
			kind: 'workflow-run-failed',
			sourceModule: `workflows.core${'.x'.repeat(60)}`,
			sourceRef: 'r'.repeat(400),
			title: `Workflow ${'N'.repeat(400)} failed`,
			body: 'b'.repeat(5_000),
			recipients: [
				`${member}-${'z'.repeat(300)}`,
				...Array.from({ length: 80 }, (_, index) => `member-${index}`),
			],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sourceModule).toHaveLength(64);
		expect(calls[0]!.sourceRef).toHaveLength(200);
		expect(calls[0]!.title).toHaveLength(200);
		expect(calls[0]!.title.startsWith('Workflow NNN')).toBe(true);
		expect(calls[0]!.body).toHaveLength(4_000);
		expect(calls[0]!.recipients).toHaveLength(64);
		expect(calls[0]!.recipients.map((id) => id.length > 128)).not.toContain(
			true,
		);
	});

	it('publishes workflow-run-failed when a node exhausts its failure policy', async () => {
		const { calls, publisher } = recordingPublisher();
		const runtime = trackedRuntime(registryWith('failed', publisher));

		const run = await runToTerminal(runtime, {
			key: 'notify-agent',
			graph: agentGraph(),
		});
		await waitForCalls(calls, 1);

		expect(run.status).toBe('failed');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			kind: 'workflow-run-failed',
			sourceRef: run.id,
			recipients: [member],
		});
		expect(calls[0]!.title).toBe('Workflow Order intake failed');
		expect(calls[0]!.body ?? '').toContain('AGENT_EXECUTION_FAILED');
	});

	it('notifies the configuring member when a service identity started the run', async () => {
		const { calls, publisher } = recordingPublisher();
		const runtime = trackedRuntime(registryWith('succeeded', publisher));

		const run = await runToTerminal(runtime, {
			key: 'notify-service',
			graph: directGraph(),
			actor: serviceActor({
				serviceId: 'automations.scheduler',
				label: 'Scheduler',
				configuredBy: actor,
			}),
		});
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.recipients).toEqual([member]);
	});

	it('finishes the run and publishes nothing when notifications.core is absent', async () => {
		const inner = registryWith('succeeded');
		let lookups = 0;
		const runtime = trackedRuntime({
			register: (id, capability) => inner.register(id, capability),
			has: (id) => inner.has(id),
			get: <T>(id: string) => {
				if (id === NOTIFICATIONS_PUBLISH_CAPABILITY) lookups += 1;
				return inner.get<T>(id);
			},
			forModule: (moduleId, declaration) =>
				inner.forModule(moduleId, declaration),
		});
		await runtime.service();
		/* Composition must not resolve the optional capability: the platform may
		   register notifications.core after workflows.core. */
		expect(lookups).toBe(0);

		const run = await runToTerminal(runtime, {
			key: 'notify-absent',
			graph: directGraph(),
		});

		expect(run.status).toBe('succeeded');
		expect(lookups).toBeGreaterThan(0);
	});

	it('settles the run and reports one warning when the publisher throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { calls, publisher } = recordingPublisher({ throws: true });
		const runtime = trackedRuntime(registryWith('succeeded', publisher));

		const run = await runToTerminal(runtime, {
			key: 'notify-throws',
			graph: directGraph(),
		});
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(run.completedAt).not.toBeNull();
		expect(calls).toHaveLength(1);
		expect(mentioning(warn, run.id)).toHaveLength(1);
		expect(mentioning(error, run.id)).toHaveLength(0);
	});
});
