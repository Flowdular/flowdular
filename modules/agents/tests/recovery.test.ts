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
import { AgentHarness, type AgentProvider } from '@flowdular/harness';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import type { AgentRepository } from '../src/services/repository.ts';
import { agentsDataClasses } from '../src/services/data-classes.ts';
import {
	AgentWorker,
	type AgentProviderResolver,
} from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-recovery';
const actor = 'owner-recovery';

function latch() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const input: CreateAgentInput = {
	key: 'recovery-agent',
	name: 'Recovery agent',
	description: 'Exercises crash recovery and lease handling.',
	instructions: 'Complete the task and report what was done.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	procedureIds: [],
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
		execute: async (context) =>
			new Promise((_, reject) => {
				context.signal.addEventListener('abort', () => {
					reasons.push(String(context.signal.reason));
					reject(new Error(String(context.signal.reason)));
				});
			}),
	};
}

async function activeAgent(service: AgentService) {
	const created = await service.createAgent(tenantId, actor, input);
	return await service.updateAgent(tenantId, created.id, actor, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
}

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

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

function trackedWorker(
	harness: AgentHarness,
	options: {
		readonly workerId: string;
		readonly leaseMs?: number;
		readonly now?: () => number;
	},
	resolver?: AgentProviderResolver,
): AgentWorker {
	const worker = new AgentWorker(
		database.repository,
		harness,
		{
			workerId: options.workerId,
			concurrency: 1,
			leaseMs: options.leaseMs ?? 1_000,
			...(options.now ? { now: options.now } : {}),
		},
		resolver,
	);
	workers.push(worker);
	return worker;
}

describe('agent run recovery and lifecycle', () => {
	it('does not claim queued work before the worker is started', async () => {
		const repository = database.repository;
		let executions = 0;
		const harness = new AgentHarness({
			providers: [okProvider(() => (executions += 1))],
		});
		const worker = trackedWorker(harness, { workerId: 'worker:not-started' });
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
		expect((await service.getRun(tenantId, queued.id)).status).toBe('queued');

		await worker.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, queued.id)).status === 'succeeded',
		);
	});

	it('lets a fresh worker claim a running run whose lease expired', async () => {
		let now = 1_000_000;
		const repository = database.repository;
		const idle = new AgentHarness({ providers: [okProvider()] });
		const idleWorker = trackedWorker(idle, {
			workerId: 'worker:crashed',
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
		const claimed = await repository.claimRun(
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
		expect((await service.getRun(tenantId, queued.id)).status).toBe('running');

		now += 5_000;
		let executions = 0;
		const fresh = trackedWorker(
			new AgentHarness({ providers: [okProvider(() => (executions += 1))] }),
			{ workerId: 'worker:fresh', now: () => now },
		);
		await fresh.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, queued.id)).status === 'succeeded',
		);
		fresh.stop();
		const recovered = await service.getRun(tenantId, queued.id);
		expect(executions).toBe(1);
		expect(recovered.attempt).toBe(2);
		expect(recovered.leaseExpiresAt).toBeNull();
		expect(
			(await repository.listAuditEvents(tenantId, 20)).filter(
				(event) => event.action === 'agent-run.claimed',
			),
		).toHaveLength(2);
		expect(await repository.verifyAuditChain(tenantId)).toBe(true);
	});

	it('aborts an execution whose lease another worker took over and leaves their row alone', async () => {
		const repository = database.repository;
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = trackedWorker(harness, { workerId: 'worker:slow' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		await worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Take a long time.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		/* A second worker treats the lease as expired and takes the run. */
		const stolen = await repository.claimRun(
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
		const run = await service.getRun(tenantId, queued.id);
		expect(run.status).toBe('running');
		expect(run.failureCode).toBeNull();
	});

	it('leaves a run recoverable when lease renewal cannot prove ownership', async () => {
		const repository = database.repository;
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = trackedWorker(harness, { workerId: 'worker:renewal-error' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		await worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Wait for recovery.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		const renewal = vi
			.spyOn(repository, 'renewLease')
			.mockRejectedValue(new Error('database temporarily unavailable'));

		await waitFor(() => worker.status().inFlight === 0);

		expect(provider.reasons).toEqual(['lease-lost']);
		expect(await service.getRun(tenantId, queued.id)).toMatchObject({
			status: 'running',
			failureCode: null,
		});
		expect(
			(await repository.listAuditEvents(tenantId, 20)).some(
				(event) => event.action === 'agent-run.failed',
			),
		).toBe(false);
		renewal.mockRestore();
		worker.stop();
	});

	it('awaits an in-flight run during terminal worker disposal', async () => {
		const repository = database.repository;
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = trackedWorker(harness, { workerId: 'worker:shutdown' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		await worker.start();
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
		const run = await service.getRun(tenantId, queued.id);
		expect(run.status).toBe('running');
		expect(run.failureCode).toBeNull();
	});

	it('drains pending discovery before disposal without starting another run', async () => {
		const repository = database.repository;
		const execute = vi.fn();
		const harness = new AgentHarness({ providers: [okProvider(execute)] });
		const worker = trackedWorker(harness, {
			workerId: 'worker:discovery-shutdown',
		});
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Wait.',
			toolGrants: [],
		});
		const original = repository.listRecoverableRuns.bind(repository);
		const entered = latch();
		const release = latch();
		vi.spyOn(repository, 'listRecoverableRuns').mockImplementationOnce(
			async (...args) => {
				entered.resolve();
				await release.promise;
				return original(...args);
			},
		);
		await worker.start();
		await entered.promise;
		let disposed = false;
		const closing = worker.dispose().then(() => {
			disposed = true;
		});
		try {
			await Promise.resolve();
			expect(disposed).toBe(false);
		} finally {
			release.resolve();
			await closing;
		}
		expect(execute).not.toHaveBeenCalled();
		expect(worker.status()).toMatchObject({ online: false, inFlight: 0 });
		expect((await service.getRun(tenantId, queued.id)).status).toBe('queued');
	});

	it('serializes concurrent event and audit appends without gaps or broken hashes', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = trackedWorker(harness, { workerId: 'worker:append-test' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Concurrent evidence.',
			toolGrants: [],
		});
		const initial = await repository.listRunEvents(tenantId, queued.id, 0);
		const after = initial.at(-1)?.sequence ?? 0;
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				repository.appendRunEvent(tenantId, queued.id, {
					sequence: index + 1,
					type: 'provider.output.delta',
					message: `chunk-${index}`,
					timestamp: Date.now(),
					metadata: {},
				}),
			),
		);
		const events = await repository.listRunEvents(tenantId, queued.id, after);
		expect(events.map((event) => event.sequence)).toEqual(
			Array.from({ length: 12 }, (_, index) => after + index + 1),
		);
		expect(new Set(events.map((event) => event.message)).size).toBe(12);
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				repository.appendAuditEvent({
					tenantId,
					actorId: actor,
					action: 'test.concurrent',
					subjectType: 'agent-run',
					subjectId: queued.id,
					metadata: { index },
					occurredAt: Date.now(),
				}),
			),
		);
		expect(
			(await repository.listAuditEvents(tenantId, 100)).filter(
				(event) => event.action === 'test.concurrent',
			),
		).toHaveLength(12);
		expect(await repository.verifyAuditChain(tenantId)).toBe(true);
		expect(
			await repository.listRunEvents('tenant-other', queued.id, 0),
		).toEqual([]);
	});

	it('awaits asynchronous readiness evidence before completing disposal', async () => {
		const entered = latch();
		const release = latch();
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = trackedWorker(
			harness,
			{ workerId: 'worker:async-evidence' },
			{
				resolve: async () => null,
				async recordRunSuccess() {
					entered.resolve();
					await release.promise;
				},
			},
		);
		const service = new AgentService(database.repository, harness, worker);
		const agent = await activeAgent(service);
		await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Persist readiness.',
			toolGrants: [],
		});
		await worker.start();
		await entered.promise;
		let disposed = false;
		const closing = worker.dispose().then(() => {
			disposed = true;
		});
		try {
			await Promise.resolve();
			expect(disposed).toBe(false);
		} finally {
			release.resolve();
			await closing;
		}
		expect(worker.status().inFlight).toBe(0);
	});

	it('cancels a queued run before any worker claims it', async () => {
		const repository = database.repository;
		let executions = 0;
		const harness = new AgentHarness({
			providers: [okProvider(() => (executions += 1))],
		});
		const worker = trackedWorker(harness, { workerId: 'worker:idle' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Never mind.',
			toolGrants: [],
		});
		const cancelled = await service.cancelRun(tenantId, actor, [], queued.id);
		expect(cancelled.status).toBe('cancelled');
		expect(cancelled.failureCode).toBe('RUN_CANCELLED');
		await worker.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		worker.stop();
		expect(executions).toBe(0);
		expect((await service.getRun(tenantId, queued.id)).status).toBe(
			'cancelled',
		);
		await expect(
			service.cancelRun(tenantId, actor, [], queued.id),
		).rejects.toThrow(/already finished/);
	});

	it('cancels a running run by aborting the worker and keeps the cancelled status', async () => {
		const repository = database.repository;
		const provider = abortableProvider();
		const harness = new AgentHarness({ providers: [provider] });
		const worker = trackedWorker(harness, { workerId: 'worker:busy' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		await worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Stop me.',
			toolGrants: [],
		});
		await waitFor(() => worker.status().inFlight === 1);
		await expect(
			service.cancelRun(tenantId, 'someone-else', [], queued.id),
		).rejects.toThrow(/Only the requester/);
		const cancelled = await service.cancelRun(
			tenantId,
			'someone-else',
			['agents.definitions.manage'],
			queued.id,
		);
		expect(cancelled.status).toBe('cancelled');
		await waitFor(() => worker.status().inFlight === 0);
		worker.stop();
		expect(provider.reasons).toEqual(['cancelled']);
		expect((await service.getRun(tenantId, queued.id)).status).toBe(
			'cancelled',
		);
		expect(
			(await repository.listAuditEvents(tenantId, 20)).map(
				(event) => event.action,
			),
		).toContain('agent-run.cancelled');
	});

	it('returns one run for two concurrent enqueues with the same idempotency key', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = trackedWorker(harness, { workerId: 'worker:idle' });
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
		expect(second!.id).toBe(first!.id);
		expect(await service.listRuns(tenantId)).toHaveLength(1);
	});

	it('binds a run idempotency key to the full request and actor authority', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = trackedWorker(harness, { workerId: 'worker:idle' });
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
		expect(await service.listRuns(tenantId)).toHaveLength(1);
	});

	it('keeps runs invisible across tenants', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [okProvider()] });
		const worker = trackedWorker(harness, { workerId: 'worker:idle' });
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Private.',
			toolGrants: [],
		});
		expect(await service.listRuns('tenant-other')).toEqual([]);
		await expect(service.getRun('tenant-other', queued.id)).rejects.toThrow(
			/not found/,
		);
		await expect(
			service.cancelRun('tenant-other', actor, [], queued.id),
		).rejects.toThrow(/not found/);
		expect(
			await repository.cancelRun(
				'tenant-other',
				queued.id,
				'nope',
				Date.now(),
				{
					tenantId: 'tenant-other',
					actorId: actor,
					action: 'agent-run.cancelled',
					subjectType: 'agent-run',
					subjectId: queued.id,
					metadata: {},
					occurredAt: Date.now(),
				},
			),
		).toBeNull();
		expect((await service.getRun(tenantId, queued.id)).status).toBe('queued');
	});

	describe('an event write refused mid-run', () => {
		function refusingRepository(owned: boolean): AgentRepository {
			return new Proxy(database.repository, {
				get(target, property) {
					const value = Reflect.get(target, property) as unknown;
					if (property === 'appendRunEvent')
						return async () => {
							throw new Error('connection reset');
						};
					if (property === 'renewLease') return async () => owned;
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}) as AgentRepository;
		}

		async function abortReason(
			repository: AgentRepository,
			workerId: string,
		): Promise<readonly string[]> {
			const provider = abortableProvider();
			const harness = new AgentHarness({ providers: [provider] });
			const worker = new AgentWorker(repository, harness, {
				workerId,
				concurrency: 1,
				leaseMs: 1_000,
			});
			workers.push(worker);
			const service = new AgentService(repository, harness, worker);
			const agent = await activeAgent(service);
			await worker.start();
			await service.enqueueRun(tenantId, actor, [], {
				agentId: agent.id,
				trigger: 'service',
				input: 'Write me an event.',
				toolGrants: [],
			});
			await waitFor(() => provider.reasons.length === 1);
			await waitFor(() => worker.status().inFlight === 0);
			return provider.reasons;
		}

		it('reads as a lost lease when the worker no longer holds the run', async () => {
			expect(
				await abortReason(refusingRepository(false), 'worker:refused-lost'),
			).toEqual(['lease-lost']);
		});

		it('reads as a persistence failure while the worker still holds the run', async () => {
			expect(
				await abortReason(refusingRepository(true), 'worker:refused-held'),
			).toEqual(['event-persistence-failed']);
		});
	});

	describe('AGENTS-ERASE-RUNNING-RUN', () => {
		/* An erasure removes the runs one account requested whatever their state, so
		   it may take a row out from under the worker holding it. That is the
		   lost-lease case: the worker stops working and settles nothing, because the
		   row it would write the outcome on no longer exists. */
		it('stops a running execution whose run an erasure removed and settles nothing', async () => {
			const repository = database.repository;
			const provider = abortableProvider();
			const harness = new AgentHarness({ providers: [provider] });
			const worker = trackedWorker(harness, { workerId: 'worker:erased' });
			const service = new AgentService(repository, harness, worker);
			const agent = await activeAgent(service);
			await worker.start();
			const queued = await service.enqueueRun(tenantId, actor, [], {
				agentId: agent.id,
				trigger: 'service',
				input: 'Erase me mid-flight.',
				toolGrants: [],
			});
			await waitFor(() => worker.status().inFlight === 1);
			const runs = agentsDataClasses(async () => repository).find(
				(entry) => entry.key === 'runs',
			)!;

			const erased = await runs.erase!({
				tenantId,
				subject: { accountId: actor },
				limit: 10,
			});

			expect(erased.removed).toBe(1);
			await waitFor(() => worker.status().inFlight === 0);
			expect(provider.reasons).toEqual(['lease-lost']);
			await expect(service.getRun(tenantId, queued.id)).rejects.toThrow(
				/not found/,
			);
			/* Nothing was settled: no failure row to write and no outcome event on a
			   run the workspace no longer holds. */
			expect(
				(await repository.listAuditEvents(tenantId, 50)).filter((event) =>
					['agent-run.failed', 'agent-run.succeeded'].includes(event.action),
				),
			).toEqual([]);
			worker.stop();
		});
	});

	it('reports a successful run as readiness evidence to the provider resolver', async () => {
		const repository = database.repository;
		const harness = new AgentHarness({ providers: [okProvider()] });
		const resolver: AgentProviderResolver = {
			resolve: async () => null,
			recordRunSuccess: vi.fn(),
		};
		const worker = trackedWorker(
			harness,
			{ workerId: 'worker:evidence' },
			resolver,
		);
		const service = new AgentService(repository, harness, worker);
		const agent = await activeAgent(service);
		await worker.start();
		const queued = await service.enqueueRun(tenantId, actor, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Prove the model.',
			toolGrants: [],
		});
		await waitFor(
			async () =>
				(await service.getRun(tenantId, queued.id)).status === 'succeeded',
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
