import { describe, expect, it } from 'vitest';
import { AgentHarness, type AgentProvider } from '@coreloom/harness';
import { AgentService, moduleDefinition } from '../src/index.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import { AgentWorker } from '../src/services/worker.ts';

const input: CreateAgentInput = {
	key: 'customer-care',
	name: 'Customer care',
	description: 'Prepares bounded customer service responses.',
	instructions: 'Prepare a factual response and escalate uncertain requests.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	skillIds: [],
	maxSteps: 4,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

function runtime(provider: AgentProvider) {
	const repository = new SqliteAgentRepository(':memory:');
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:test',
		concurrency: 1,
		leaseMs: 1_000,
	});
	const service = new AgentService(repository, harness, worker);
	return { repository, service, worker };
}

async function waitForTerminal(
	service: AgentService,
	tenantId: string,
	runId: string,
) {
	for (let index = 0; index < 50; index += 1) {
		const run = service.getRun(tenantId, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Agent run did not finish in time.');
}

describe('agents.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('agents.core');
	});

	it('versions tenant-scoped definitions and records an audit hash chain', () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			}),
		};
		const { repository, service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		expect(created.status).toBe('draft');
		expect(service.listAgents('tenant-b')).toEqual([]);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: 1,
		});
		expect(active.revision).toBe(2);
		expect(repository.verifyAuditChain('tenant-a')).toBe(true);
		expect(repository.listAuditEvents('tenant-a', 10)).toHaveLength(2);
	});

	it('returns a queued run before detached provider work completes', async () => {
		let providerCompleted = false;
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				providerCompleted = true;
				return {
					output: 'Background work completed.',
					usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
					finishReason: 'stop',
				};
			},
		};
		const { repository, service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: created.revision,
		});
		const queued = await service.enqueueRun(
			'tenant-a',
			'owner-a',
			['agents.runs.execute'],
			{
				agentId: active.id,
				trigger: 'workflow',
				input: 'Handle order exception 42.',
				toolGrants: [],
				idempotencyKey: 'order-exception-42',
			},
		);
		expect(queued.status).toBe('queued');
		expect(providerCompleted).toBe(false);
		const completed = await waitForTerminal(service, 'tenant-a', queued.id);
		expect(completed.status).toBe('succeeded');
		expect(completed.output).toBe('Background work completed.');
		expect(completed.events.map((event) => event.type)).toEqual([
			'run.started',
			'provider.started',
			'provider.completed',
			'run.completed',
		]);
		expect(repository.verifyAuditChain('tenant-a')).toBe(true);
	});

	it('deduplicates fire-and-forget requests by tenant idempotency key', async () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			}),
		};
		const { service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: 1,
		});
		const request = {
			agentId: active.id,
			trigger: 'service' as const,
			input: 'Prepare summary.',
			toolGrants: [],
			idempotencyKey: 'summary-request-0001',
		};
		const first = await service.enqueueRun('tenant-a', 'owner-a', [], request);
		const second = await service.enqueueRun('tenant-a', 'owner-a', [], request);
		expect(second.id).toBe(first.id);
	});
});
