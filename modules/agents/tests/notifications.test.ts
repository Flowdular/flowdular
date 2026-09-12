import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type MockInstance,
} from 'vitest';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentProvider,
} from '@flowdular/harness';
import { serviceActor, type Actor } from '@flowdular/kernel';
import { AgentService } from '../src/services/agent-service.ts';
import {
	publishRunOutcome,
	type NotificationPublishInput,
	type NotificationPublisher,
	type NotificationPublisherResolver,
} from '../src/services/notifications.ts';
import {
	createAgentRuntime,
	type AgentRuntime,
} from '../src/server/runtime.ts';
import type { AgentRepository } from '../src/services/repository.ts';
import { AgentWorker } from '../src/services/worker.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-notify';
const member = 'member-notify';

const definition: CreateAgentInput = {
	key: 'notify-agent',
	name: 'Order triage',
	description: 'Exercises run outcome notifications.',
	instructions: 'Answer the request and stop.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

/* The local simulation provider is the one a composed runtime can reach: the
   broker resolves every other provider id from a stored tenant connection. */
const composedDefinition: CreateAgentInput = {
	...definition,
	key: 'notify-composed',
	provider: 'local-simulation',
	model: 'deterministic-v1',
};

function okProvider(): AgentProvider {
	return {
		id: 'test-provider',
		execute: async () => ({
			output: 'done',
			usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			finishReason: 'stop',
		}),
	};
}

function brokenProvider(): AgentProvider {
	return {
		id: 'test-provider',
		execute: async () => {
			throw new Error('The provider refused the request.');
		},
	};
}

/** A provider that reports its own free-text code, the way a real SDK does. */
function codedProvider(code: string): AgentProvider {
	return {
		id: 'test-provider',
		execute: async () => {
			throw Object.assign(new Error('The provider refused the request.'), {
				code,
			});
		},
	};
}

/** Records what agents.core asked notifications.core to publish. */
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

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];
const runtimes: AgentRuntime[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await database.dispose();
});

async function runtime(
	provider: AgentProvider,
	notifications?: () => NotificationPublisher | null,
) {
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:notify',
		concurrency: 1,
		leaseMs: 1_000,
		...(notifications ? { notifications } : {}),
	});
	workers.push(worker);
	await worker.start();
	return new AgentService(database.repository, harness, worker);
}

/* The composition the platform builds, not a worker assembled by the test:
   the notifications resolver has to survive the runtime wiring to publish. */
function composedRuntime(
	notifications: NotificationPublisherResolver,
): AgentRuntime {
	const runtime = createAgentRuntime({
		databases: database.databases,
		workerConcurrency: 1,
		workerLeaseMs: 1_000,
		providers: [new LocalSimulationProvider()],
		providerHostAllowlist: new Set(),
		providerReadinessTtlMs: 10_000,
		providerReadinessTimeoutMs: 1_000,
		runGrantTtlMs: 10_000,
		environment: { NODE_ENV: 'test' },
		notifications,
	});
	runtimes.push(runtime);
	return runtime;
}

async function activeAgent(
	service: AgentService,
	input: CreateAgentInput = definition,
) {
	const created = await service.createAgent(tenantId, member, input);
	return await service.updateAgent(tenantId, created.id, member, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
}

async function waitForTerminal(service: AgentService, runId: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = await service.getRun(tenantId, runId);
		if (run.status === 'succeeded' || run.status === 'failed') return run;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('The agent run did not reach a terminal state in time.');
}

async function runToTerminal(
	service: AgentService,
	actor: Actor | string,
	input: CreateAgentInput = definition,
) {
	const agent = await activeAgent(service, input);
	const queued = await service.enqueueRun(tenantId, actor, [], {
		agentId: agent.id,
		trigger: 'service',
		input: 'Triage this order.',
		toolGrants: [],
	});
	return await waitForTerminal(service, queued.id);
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
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('AGENTS-NOTIFY-RUN', () => {
	it('publishes one agent-run-completed notification to the member who started the run', async () => {
		const { calls, publisher } = recordingPublisher();
		const service = await runtime(okProvider(), () => publisher);

		const run = await runToTerminal(service, member);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tenantId,
			kind: 'agent-run-completed',
			sourceModule: 'agents.core',
			sourceRef: run.id,
			recipients: [member],
		});
		expect(calls[0]!.title).toBe('Agent Order triage finished');
		expect(calls[0]!.body ?? '').not.toContain('Triage this order.');
	});

	it('publishes through the composed runtime, not only a hand-built worker', async () => {
		const { calls, publisher } = recordingPublisher();
		const composed = composedRuntime(() => publisher);
		const service = await composed.service();
		composed.start();

		const run = await runToTerminal(service, member, composedDefinition);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tenantId,
			kind: 'agent-run-completed',
			sourceModule: 'agents.core',
			sourceRef: run.id,
			recipients: [member],
		});
	});

	it('publishes agent-run-failed with the stable failure code and no provider message', async () => {
		const { calls, publisher } = recordingPublisher();
		const service = await runtime(brokenProvider(), () => publisher);

		const run = await runToTerminal(service, member);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('failed');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			kind: 'agent-run-failed',
			sourceRef: run.id,
			recipients: [member],
		});
		expect(calls[0]!.title).toBe('Agent Order triage failed');
		expect(calls[0]!.body ?? '').not.toContain(
			'The provider refused the request.',
		);
	});

	it('reports the stable failure code when the provider reports free text', async () => {
		const { calls, publisher } = recordingPublisher();
		const service = await runtime(
			codedProvider('Invalid api key sk-live-42 for account acme'),
			() => publisher,
		);

		const run = await runToTerminal(service, member);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('failed');
		expect(run.failureCode).toBe('AGENT_EXECUTION_FAILED');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.body).toBe('The run stopped with AGENT_EXECUTION_FAILED.');
	});

	it('publishes nothing when the failure record could not be written', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { calls, publisher } = recordingPublisher();
		const harness = new AgentHarness({ providers: [brokenProvider()] });
		/* Only the terminal write fails, the way it does once another worker
		   took the row over, so the worker takes its settle-failed path. */
		const repository = new Proxy(database.repository, {
			get(target, property) {
				if (property === 'failRun') {
					return async () => {
						throw new Error('The run is owned by another worker.');
					};
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as AgentRepository;
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:unsettled',
			concurrency: 1,
			leaseMs: 1_000,
			notifications: () => publisher,
		});
		workers.push(worker);
		await worker.start();
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);

		const queued = await service.enqueueRun(tenantId, member, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Triage this order.',
			toolGrants: [],
		});
		for (let attempt = 0; attempt < 400; attempt += 1) {
			if (mentioning(error, queued.id).length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(mentioning(error, queued.id).length).toBeGreaterThan(0);
		expect(calls).toHaveLength(0);
	});

	it('clamps every bounded field before the publish leaves agents.core', async () => {
		const { calls, publisher } = recordingPublisher();

		await publishRunOutcome(() => publisher, {
			tenantId,
			kind: 'agent-run-failed',
			sourceModule: `agents.core${'.x'.repeat(60)}`,
			sourceRef: 'r'.repeat(400),
			title: `Agent ${'N'.repeat(400)} failed`,
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
		expect(calls[0]!.title.startsWith('Agent NNN')).toBe(true);
		expect(calls[0]!.body).toHaveLength(4_000);
		expect(calls[0]!.recipients).toHaveLength(64);
		expect(calls[0]!.recipients.map((id) => id.length > 128)).not.toContain(
			true,
		);
	});

	it('notifies the configuring member when a service identity started the run', async () => {
		const { calls, publisher } = recordingPublisher();
		const service = await runtime(okProvider(), () => publisher);

		const run = await runToTerminal(
			service,
			serviceActor({
				serviceId: 'automations.scheduler',
				label: 'Scheduler',
				configuredBy: {
					accountId: member,
					email: 'member-notify@example.com',
				},
			}),
		);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.recipients).toEqual([member]);
	});

	it('stays silent for an agent run a workflow owns', async () => {
		const { calls, publisher } = recordingPublisher();
		const service = await runtime(okProvider(), () => publisher);
		const agent = await activeAgent(service);

		const accepted = await service.enqueueRevisionRun(
			{
				tenantId,
				workflowRunId: 'workflow-run-1',
				actor: { kind: 'user', id: member, label: 'Member' },
				permissionSnapshot: [],
			},
			{
				agentId: agent.id,
				revision: agent.revision,
				input: 'Triage this order.',
				toolGrants: [],
				outputContract: { kind: 'text' },
				idempotencyKey: 'workflow-run-1:node-1:attempt-1',
			},
		);
		const run = await waitForTerminal(service, accepted.runId);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		/* workflows.core publishes the outcome the person asked for, so a step
		   inside that workflow must not add one of its own. */
		expect(calls).toHaveLength(0);
	});

	it('completes the run and publishes nothing when notifications.core is absent', async () => {
		let lookups = 0;
		const service = await runtime(okProvider(), () => {
			lookups += 1;
			return null;
		});
		/* Composition must not resolve the optional capability: the platform may
		   register notifications.core after agents.core. */
		expect(lookups).toBe(0);

		const run = await runToTerminal(service, member);

		expect(run.status).toBe('succeeded');
		expect(run.output).toBe('done');
		expect(lookups).toBeGreaterThan(0);
	});

	it('settles the run and reports one warning when the publisher throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { calls, publisher } = recordingPublisher({ throws: true });
		const service = await runtime(okProvider(), () => publisher);

		const run = await runToTerminal(service, member);
		await waitForCalls(calls, 1);

		expect(run.status).toBe('succeeded');
		expect(run.output).toBe('done');
		expect(calls).toHaveLength(1);
		expect(await database.repository.verifyAuditChain(tenantId)).toBe(true);
		expect(mentioning(warn, run.id)).toHaveLength(1);
		expect(mentioning(error, run.id)).toHaveLength(0);
	});
});
