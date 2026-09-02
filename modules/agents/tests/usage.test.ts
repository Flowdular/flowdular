import { describe, expect, it } from 'vitest';
import { AgentHarness, type AgentProvider } from '@coreloom/harness';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import { AgentUsageService } from '../src/services/usage-service.ts';
import { AgentWorker } from '../src/services/worker.ts';

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
	skillIds: [],
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

function fixture(monthlyCostCapUsd = 0) {
	const repository = new SqliteAgentRepository(':memory:');
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:usage',
		concurrency: 1,
		leaseMs: 1_000,
	});
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
	const created = service.createAgent(TENANT, OWNER, definition);
	const agent = service.updateAgent(TENANT, created.id, OWNER, {
		...definition,
		status: 'active',
		expectedRevision: created.revision,
	});
	return { service, usage, worker, agent };
}

async function waitForTerminal(service: AgentService, runId: string) {
	for (let index = 0; index < 100; index += 1) {
		const run = service.getRun(TENANT, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Agent run did not finish in time.');
}

describe('agent usage and budgets', () => {
	it('prices a completed run and keeps usage tenant scoped', async () => {
		const { service, usage, worker, agent } = fixture();
		worker.start();
		try {
			const run = await service.enqueueRun(TENANT, OWNER, [], {
				agentId: agent.id,
				trigger: 'playground',
				input: 'Do the work.',
				toolGrants: [],
			});
			await waitForTerminal(service, run.id);
			expect(usage.summary(TENANT).month).toMatchObject({
				runs: 1,
				costMicroUsd: 7_000,
			});
			expect(usage.summary('another-tenant').month.runs).toBe(0);
		} finally {
			worker.stop();
		}
	});

	it('refuses another enqueue after the workspace budget is spent', async () => {
		const { service, worker, agent } = fixture(0.005);
		worker.start();
		try {
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
		} finally {
			worker.stop();
		}
	});
});
