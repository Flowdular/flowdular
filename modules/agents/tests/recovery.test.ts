import { describe, expect, it, vi } from 'vitest';
import { AgentHarness, type AgentProvider } from '@coreloom/harness';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import {
	AgentWorker,
	type AgentProviderResolver,
} from '../src/services/worker.ts';

const tenantId = 'tenant-recovery';
const actor = 'owner-recovery';

const input: CreateAgentInput = {
	key: 'recovery-agent',
	name: 'Recovery agent',
	description: 'Exercises crash recovery and lease handling.',
	instructions: 'Complete the task and report what was done.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	skillIds: [],
	maxSteps: 2,
	timeoutMs: 10_000,
	temperature: 0,
	status: 'draft',
};

function okProvider(onExecute?: () => void): AgentProvider {
	return {
		id: 'test-provider',
		execute: async () => {
			onExecute?.();
			return {
				output: 'done',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			};
		},
	};
}

/* Settles only when aborted and reports the abort reason as the failure. */
function abortableProvider(): AgentProvider & {
	readonly reasons: string[];
} {
	const reasons: string[] = [];
	return {
		id: 'test-provider',
		reasons,
		execute: (context) =>
			new Promise((_, reject) => {
				context.signal.addEventListener('abort', () => {
					reasons.push(String(context.signal.reason));
					reject(new Error(String(context.signal.reason)));
				});
			}),
	};
}

async function activeAgent(service: AgentService) {
	const created = service.createAgent(tenantId, actor, input);
	return service.updateAgent(tenantId, created.id, actor, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe('agent run recovery and lifecycle', () => {
	it('does not claim queued work before the worker is started', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		let executions = 0;
		const harness = new AgentHarness({
			providers: [okProvider(() => (executions += 1))],
		});
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:not-started',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Wait for explicit startup.',
			toolGrants: [],
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(executions).toBe(0);
		expect(service.getRun(tenantId, queued.id).status).toBe('queued');

		worker.start();
		await waitFor(
			() => service.getRun(tenantId, queued.id).status === 'succeeded',
		);
		await worker.dispose();
		repository.close();
	});

	it('lets a fresh worker claim a running run whose lease expired', async () => {
		let now = 1_000_000;
		const repository = new SqliteAgentRepository(':memory:');
		const idle = new AgentHarness({ providers: [okProvider()] });
		const idleWorker = new AgentWorker(repository, idle, {
			workerId: 'worker:crashed',
			concurrency: 1,
			leaseMs: 1_000,
			now: () => now,
		});
		const service = new AgentService(repository, idle, idleWorker);
		const agent = await activeAgent(service);
		/* The crashed worker claimed the run and never came back, so its own
		   process must not drain the queue in this test. */
		idleWorker.stop();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Recover me.',
			toolGrants: [],
		});
		const claimed = repository.claimRun(
			tenantId,
			queued.id,
			'worker:crashed',
			now,
			now + 1_000,
			{
				tenantId,
				actorId: 'worker:crashed',
				action: 'agent-run.claimed',
				subjectType: 'agent-run',
				subjectId: queued.id,
				metadata: {},
				occurredAt: now,
			},
		);
		expect(claimed?.run.attempt).toBe(1);
		expect(service.getRun(tenantId, queued.id).status).toBe('running');

		now += 5_000;
		let executions = 0;
		const fresh = new AgentWorker(
			repository,
			new AgentHarness({ providers: [okProvider(() => (executions += 1))] }),
			{
				workerId: 'worker:fresh',
				concurrency: 1,
				leaseMs: 1_000,
				now: () => now,
			},
		);
		fresh.start();
		await waitFor(
			() => service.getRun(tenantId, queued.id).status === 'succeeded',
		);
		fresh.stop();
		const recovered = service.getRun(tenantId, queued.id);
		expect(executions).toBe(1);
		expect(recovered.attempt).toBe(2);
		expect(recovered.leaseExpiresAt).toBeNull();
		expect(
			repository
				.listAuditEvents(tenantId, 20)
				.filter((event) => event.action === 'agent-run.claimed'),
		).toHaveLength(2);
		expect(repository.verifyAuditChain(tenantId)).toBe(true);
	});

	it('aborts an execution whose lease another worker took over and leaves their row alone', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:slow',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Take a long time.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		/* A second worker treats the lease as expired and takes the run. */
		const stolen = repository.claimRun(
			tenantId,
			queued.id,
			'worker:other',
			Date.now() + 60_000,
			Date.now() + 120_000,
			{
				tenantId,
				actorId: 'worker:other',
				action: 'agent-run.claimed',
				subjectType: 'agent-run',
				subjectId: queued.id,
				metadata: {},
				occurredAt: Date.now() + 60_000,
			},
		);
		expect(stolen?.run.attempt).toBe(2);
		await waitFor(() => worker.status().inFlight === 0);
		worker.stop();
		expect(provider.reasons).toEqual(['lease-lost']);
		const run = service.getRun(tenantId, queued.id);
		expect(run.status).toBe('running');
		expect(run.failureCode).toBeNull();
	});

	it('leaves a run recoverable when lease renewal cannot prove ownership', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:renewal-error',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Wait for recovery.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		const renewal = vi
			.spyOn(repository, 'renewLease')
			.mockImplementation(() => {
				throw new Error('database temporarily unavailable');
			});

		await waitFor(() => worker.status().inFlight === 0);

		expect(provider.reasons).toEqual(['lease-lost']);
		expect(service.getRun(tenantId, queued.id)).toMatchObject({
			status: 'running',
			failureCode: null,
		});
		expect(
			repository
				.listAuditEvents(tenantId, 20)
				.some((event) => event.action === 'agent-run.failed'),
		).toBe(false);
		renewal.mockRestore();
		worker.stop();
		repository.close();
	});

	it('awaits an in-flight run during terminal worker disposal', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:shutdown',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Resume after restart.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);

		await worker.dispose();

		expect(worker.status().inFlight).toBe(0);
		expect(provider.reasons).toEqual(['worker-shutdown']);
		const run = service.getRun(tenantId, queued.id);
		expect(run.status).toBe('running');
		expect(run.failureCode).toBeNull();
	});

	it('cancels a queued run before any worker claims it', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		let executions = 0;
		const harness = new AgentHarness({
			providers: [okProvider(() => (executions += 1))],
		});
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:idle',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Never mind.',
			toolGrants: [],
		});
		const cancelled = service.cancelRun(tenantId, actor, [], queued.id);
		expect(cancelled.status).toBe('cancelled');
		expect(cancelled.failureCode).toBe('RUN_CANCELLED');
		worker.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		worker.stop();
		expect(executions).toBe(0);
		expect(service.getRun(tenantId, queued.id).status).toBe('cancelled');
		expect(() => service.cancelRun(tenantId, actor, [], queued.id)).toThrow(
			/already finished/,
		);
	});

	it('cancels a running run by aborting the worker and keeps the cancelled status', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:busy',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Stop me.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		expect(() =>
			service.cancelRun(tenantId, 'someone-else', [], queued.id),
		).toThrow(/Only the requester/);
		const cancelled = service.cancelRun(
			tenantId,
			'someone-else',
			['agents.definitions.manage'],
			queued.id,
		);
		expect(cancelled.status).toBe('cancelled');
		await waitFor(() => worker.status().inFlight === 0);
		worker.stop();
		expect(provider.reasons).toEqual(['cancelled']);
		expect(service.getRun(tenantId, queued.id).status).toBe('cancelled');
		expect(
			repository.listAuditEvents(tenantId, 20).map((event) => event.action),
		).toContain('agent-run.cancelled');
	});

	it('returns one run for two concurrent enqueues with the same idempotency key', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:idle',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const request = {
			agentId: agent.id,
			trigger: 'service' as const,
			input: 'Once only.',
			toolGrants: [],
			idempotencyKey: 'once-only-0001',
		};
		const [first, second] = await Promise.all([
			service.enqueueRun(tenantId, actor, [], request),
			service.enqueueRun(tenantId, actor, [], request),
		]);
		expect(second.id).toBe(first.id);
		expect(service.listRuns(tenantId)).toHaveLength(1);
	});

	it('binds a run idempotency key to the full request and actor authority', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:idle',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const request = {
			agentId: agent.id,
			trigger: 'service' as const,
			input: 'Original request.',
			toolGrants: [],
			idempotencyKey: 'bound-request-0001',
		};
		await service.enqueueRun(tenantId, actor, [], request);

		await expect(
			service.enqueueRun(tenantId, actor, [], {
				...request,
				input: 'Different request.',
			}),
		).rejects.toMatchObject({ code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT' });
		await expect(
			service.enqueueRun(
				tenantId,
				{
					kind: 'agent',
					id: actor,
					label: 'Same id, different authority',
					runId: 'parent-run',
				},
				[],
				request,
			),
		).rejects.toMatchObject({ code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT' });
		expect(service.listRuns(tenantId)).toHaveLength(1);
		repository.close();
	});

	it('keeps runs invisible across tenants', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:idle',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Private.',
			toolGrants: [],
		});
		expect(service.listRuns('tenant-other')).toEqual([]);
		expect(() => service.getRun('tenant-other', queued.id)).toThrow(
			/not found/,
		);
		expect(() =>
			service.cancelRun('tenant-other', actor, [], queued.id),
		).toThrow(/not found/);
		expect(
			repository.cancelRun('tenant-other', queued.id, 'nope', Date.now(), {
				tenantId: 'tenant-other',
				actorId: actor,
				action: 'agent-run.cancelled',
				subjectType: 'agent-run',
				subjectId: queued.id,
				metadata: {},
				occurredAt: Date.now(),
			}),
		).toBeNull();
		expect(service.getRun(tenantId, queued.id).status).toBe('queued');
	});

	it('reports a successful run as readiness evidence to the provider resolver', async () => {
		const repository = new SqliteAgentRepository(':memory:');
		const harness = new AgentHarness({ providers: [okProvider()] });
		const resolver: AgentProviderResolver = {
			resolve: async () => null,
			recordRunSuccess: vi.fn(),
		};
		const worker = new AgentWorker(
			repository,
			harness,
			{ workerId: 'worker:evidence', concurrency: 1, leaseMs: 1_000 },
			resolver,
		);
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Prove the model.',
			toolGrants: [],
		});
		await waitFor(
			() => service.getRun(tenantId, queued.id).status === 'succeeded',
		);
		worker.stop();
		expect(resolver.recordRunSuccess).toHaveBeenCalledWith(
			tenantId,
			'test-provider',
			'test-model',
			expect.any(Number),
			expect.any(Number),
		);
	});
});
