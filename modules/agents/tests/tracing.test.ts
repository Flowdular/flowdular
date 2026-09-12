import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import { LocalSimulationProvider } from '@flowdular/harness';
import { createTracer } from '@flowdular/server';
import type { CreateAgentInput } from '../src/domain/types.ts';
import {
	createAgentRuntime,
	type AgentRuntime,
} from '../src/server/runtime.ts';
import type { AgentService } from '../src/services/agent-service.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-trace';
const member = 'member-trace';

/* The local simulation provider is the one a composed runtime can reach: every
   other provider id is resolved from a stored tenant connection. */
const definition: CreateAgentInput = {
	key: 'trace-agent',
	name: 'Traced agent',
	description: 'Exercises the span the harness records per provider call.',
	instructions: 'Answer the request and stop.',
	provider: 'local-simulation',
	model: 'deterministic-v1',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

let database: AgentsTestDatabase;
const runtimes: AgentRuntime[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

afterAll(async () => {
	await database.dispose();
});

function composedRuntime(
	tracer?: ReturnType<typeof createTracer>,
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
		...(tracer ? { tracer } : {}),
	});
	runtimes.push(runtime);
	return runtime;
}

async function runToTerminal(service: AgentService): Promise<string> {
	const created = await service.createAgent(tenantId, member, definition);
	const agent = await service.updateAgent(tenantId, created.id, member, {
		...definition,
		status: 'active',
		expectedRevision: created.revision,
	});
	const queued = await service.enqueueRun(tenantId, member, [], {
		agentId: agent.id,
		trigger: 'service',
		input: 'Say something.',
		toolGrants: [],
	});
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = await service.getRun(tenantId, queued.id);
		if (run.status === 'succeeded' || run.status === 'failed') return run.id;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('The agent run did not reach a terminal state in time.');
}

describe('agents.core tracing', () => {
	it('records a provider span for a run the composed runtime performed', async () => {
		const tracer = createTracer();
		const composed = composedRuntime(tracer);
		const service = await composed.service();
		composed.start();

		const runId = await runToTerminal(service);

		const span = tracer
			.drain()
			.find((recorded) => recorded.name === 'provider local-simulation');
		expect(span?.kind).toBe('client');
		expect(span?.status).toBe('ok');
		expect(span?.attributes['flowdular.agent.run_id']).toBe(runId);
		expect(span?.attributes['flowdular.agent.model']).toBe('deterministic-v1');
	});
});
