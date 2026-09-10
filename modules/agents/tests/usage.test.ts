import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import { AgentHarness, type AgentProvider } from '@flowdular/harness';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentUsageService } from '../src/services/usage-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-usage';
const OWNER = 'owner-usage';

const definition: CreateAgentInput = {
	key: 'usage-agent',
	name: 'Usage agent',
	description: 'Exercises cost accounting and budgets.',
	instructions: 'Answer briefly and factually.',
	provider: 'test-provider',
	model: 'claude-sonnet-5',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

const provider: AgentProvider = {
	id: 'test-provider',
	execute: async () => ({
		output: 'ok',
		usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
		finishReason: 'stop',
	}),
};

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

async function fixture(monthlyCostCapUsd = 0) {
	const repository = database.repository;
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:usage',
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	const usage = new AgentUsageService(repository, {
		monthlyCostCapUsd: () => monthlyCostCapUsd,
		agentMonthlyCostCapUsd: () => 0,
	} as never);
	const service = new AgentService(
		repository,
		harness,
		worker,
		undefined,
		Date.now,
		undefined,
		usage,
	);
	const created = await service.createAgent(TENANT, OWNER, definition);
	const agent = await service.updateAgent(TENANT, created.id, OWNER, {
		...definition,
		status: 'active',
		expectedRevision: created.revision,
	});
	return { service, usage, worker, agent };
}

async function waitForTerminal(service: AgentService, runId: string) {
	for (let index = 0; index < 300; index += 1) {
		const run = await service.getRun(TENANT, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Agent run did not finish in time.');
}

describe('agent usage and budgets', () => {
	it('prices a completed run and keeps usage tenant scoped', async () => {
		const { service, usage, worker, agent } = await fixture();
		await worker.start();
		const run = await service.enqueueRun(TENANT, OWNER, [], {
			agentId: agent.id,
			trigger: 'playground',
			input: 'Do the work.',
			toolGrants: [],
		});
		await waitForTerminal(service, run.id);
		expect((await usage.summary(TENANT)).month).toMatchObject({
			runs: 1,
			costMicroUsd: 7_000,
		});
		expect((await usage.summary('another-tenant')).month.runs).toBe(0);
		worker.stop();
	});

	it('refuses another enqueue after the workspace budget is spent', async () => {
		const { service, worker, agent } = await fixture(0.005);
		await worker.start();
		const run = await service.enqueueRun(TENANT, OWNER, [], {
			agentId: agent.id,
			trigger: 'playground',
			input: 'First run.',
			toolGrants: [],
		});
		await waitForTerminal(service, run.id);
		await expect(
			service.enqueueRun(TENANT, OWNER, [], {
				agentId: agent.id,
				trigger: 'playground',
				input: 'Second run.',
				toolGrants: [],
			}),
		).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', status: 409 });
		worker.stop();
	});
});
