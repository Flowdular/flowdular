import type {
	DatabaseAdapterLease,
	DatabaseTransaction,
} from '@flowdular/database';
import { AgentHarness } from '@flowdular/harness';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
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
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { workerIndicator } from '../src/client/presentation.ts';
import type { AgentWorkerStatus } from '../src/domain/types.ts';
import {
	AGENT_WORKER_TENANT,
	DatabaseAgentRepository,
} from '../src/services/database-repository.ts';
import {
	agentPrincipal,
	composeAgents,
	queueTenantRun,
	type ComposedAgents,
} from './support/composition.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const DAY = 86_400_000;

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const instances: ComposedAgents[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const opened of instances.splice(0)) await opened.composed.dispose?.();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

async function instance(
	settings: Readonly<Record<string, unknown>>,
): Promise<ComposedAgents> {
	const composed = composeAgents({ databases: database.databases, settings });
	instances.push(composed);
	await composed.composed.prepare();
	return composed;
}

async function workerStatus(
	target: ComposedAgents,
	tenant: string,
): Promise<AgentWorkerStatus> {
	const response = await target.call(
		agentPrincipal(tenant, ['agents.runs.read']),
		'/api/agent-runs/worker',
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { worker: AgentWorkerStatus }).worker;
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

/* Forced row-level security binds the owner too, so heartbeats are read and
   seeded under the workers' sentinel tenant. */
const asWorkers = <T>(
	operation: (transaction: DatabaseTransaction) => Promise<T>,
) =>
	owner.database.transaction(operation, {
		tenantId: AGENT_WORKER_TENANT,
		access: 'write',
	});

const runStatus = async (tenant: string, id: string) =>
	(await database.repository.getRun(tenant, id))?.status;

/* Holds every run inside the harness until `release` or an abort. */
function holdRuns() {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const execute = AgentHarness.prototype.execute;
	vi.spyOn(AgentHarness.prototype, 'execute').mockImplementation(
		async function (this: AgentHarness, ...args: Parameters<typeof execute>) {
			await new Promise<void>((resolve) => {
				void held.then(resolve);
				args[1]?.signal?.addEventListener('abort', () => resolve());
			});
			return execute.apply(this, args);
		},
	);
	return { release };
}

describe('agents.core worker availability', () => {
	it('AGENTS-WORKER-AVAILABILITY answers not-seen, online with the summed concurrency and only the asking workspace runs, then offline with the newest heartbeat, in every role', async () => {
		/* The clock is moved past the freshness window instead of waiting it out. */
		const realNow = Date.now.bind(Date);
		let offset = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
		const settings = { workerLeaseMs: 1_000, workerFreshnessMs: 30_000 };
		const web = await instance(settings);
		expect(await workerStatus(web, 'tenant-a')).toEqual({
			state: 'not-seen',
			online: false,
			concurrency: 0,
			inFlight: 0,
			leaseMs: 1_000,
			lastHeartbeatAt: null,
		});

		const held = holdRuns();
		const single = await instance({ ...settings, workerConcurrency: 1 });
		const pair = await instance({ ...settings, workerConcurrency: 2 });
		await single.composed.startWorker();
		await pair.composed.startWorker();
		for (const role of [web, single, pair]) {
			expect(await workerStatus(role, 'tenant-a')).toMatchObject({
				state: 'online',
				online: true,
				concurrency: 3,
				inFlight: 0,
				lastHeartbeatAt: expect.any(Number),
			});
		}

		await pair.composed.stop?.();
		const runId = await queueTenantRun(web, 'tenant-a');
		await waitFor(
			async () => (await runStatus('tenant-a', runId)) === 'running',
		);
		expect(await workerStatus(web, 'tenant-a')).toMatchObject({
			state: 'online',
			inFlight: 1,
		});
		expect(await workerStatus(web, 'tenant-b')).toMatchObject({
			state: 'online',
			inFlight: 0,
		});

		/* Past the window only a worker that kept beating counts: the one whose
		   single slot is busy with the held run. */
		offset += 31_000;
		await waitFor(async () => {
			const status = await workerStatus(web, 'tenant-a');
			return status.state === 'online' && status.concurrency === 1;
		});

		held.release();
		await single.composed.stop?.();
		const newest = await asWorkers(
			async (transaction) =>
				(
					await transaction.query<{ newest: string | number }>({
						text: 'SELECT MAX(heartbeat_at) AS newest FROM agent_worker_heartbeats',
					})
				).rows[0]!.newest,
		);
		offset += 31_000;
		for (const role of [web, single]) {
			expect(await workerStatus(role, 'tenant-a')).toMatchObject({
				state: 'offline',
				online: false,
				concurrency: 0,
				lastHeartbeatAt: Number(newest),
			});
		}
	});

	it('AGENTS-WORKER-AVAILABILITY keeps draining when a heartbeat cannot be recorded', async () => {
		vi.spyOn(
			DatabaseAgentRepository.prototype,
			'recordWorkerHeartbeat',
		).mockRejectedValue(new Error('heartbeat refused'));
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const web = await instance({});
		const runId = await queueTenantRun(web, 'tenant-a');
		const worker = await instance({});
		await worker.composed.startWorker();
		await waitFor(
			async () => (await runStatus('tenant-a', runId)) === 'succeeded',
		);
		expect(
			logged.mock.calls.some((call) =>
				/worker heartbeat could not be recorded/.test(String(call[0])),
			),
		).toBe(true);
		expect(await workerStatus(web, 'tenant-a')).toMatchObject({
			state: 'not-seen',
		});
	});

	it('AGENTS-WORKER-AVAILABILITY removes heartbeats older than a day except the newest and keeps them out of every workspace', async () => {
		const now = Date.now();
		const workers = () =>
			asWorkers(async (transaction) =>
				(
					await transaction.query<{ worker_id: string }>({
						text: 'SELECT worker_id FROM agent_worker_heartbeats ORDER BY worker_id',
					})
				).rows.map((row) => row.worker_id),
			);
		await asWorkers((transaction) =>
			transaction.execute({
				text: `INSERT INTO agent_worker_heartbeats
				       (tenant_id, worker_id, started_at, heartbeat_at, concurrency)
				       VALUES ($1, 'w-1', $2, $2, 1), ($1, 'w-2', $3, $3, 1)`,
				parameters: [AGENT_WORKER_TENANT, now - 3 * DAY, now - 2 * DAY],
			}),
		);
		await database.repository.recordWorkerHeartbeat(
			{
				workerId: 'w-2',
				startedAt: now - 2 * DAY,
				heartbeatAt: now - 2 * DAY,
				concurrency: 1,
			},
			now - DAY,
		);
		expect(await workers()).toEqual(['w-2']);
		await database.repository.recordWorkerHeartbeat(
			{ workerId: 'w-3', startedAt: now, heartbeatAt: now, concurrency: 2 },
			now - DAY,
		);
		expect(await workers()).toEqual(['w-3']);

		const runtime = await database.databases.acquire({
			namespace: 'agents.core',
			purpose: 'runtime',
		});
		try {
			const asWorkspace = <T>(
				operation: (transaction: DatabaseTransaction) => Promise<T>,
			) =>
				runtime.database.transaction(operation, {
					tenantId: 'tenant-a',
					access: 'write',
				});
			expect(
				await asWorkspace(
					async (transaction) =>
						(
							await transaction.query({
								text: 'SELECT worker_id FROM agent_worker_heartbeats',
							})
						).rows,
				),
			).toEqual([]);
			await expect(
				asWorkspace((transaction) =>
					transaction.execute({
						text: `INSERT INTO agent_worker_heartbeats
						       (tenant_id, worker_id, started_at, heartbeat_at, concurrency)
						       VALUES ('tenant-a', 'w-tenant', 1, 1, 1)`,
					}),
				),
			).rejects.toMatchObject({ code: '23514' });
			await expect(
				asWorkspace((transaction) =>
					transaction.execute({
						text: `INSERT INTO agent_worker_heartbeats
						       (tenant_id, worker_id, started_at, heartbeat_at, concurrency)
						       VALUES ($1, 'w-tenant', 1, 1, 1)`,
						parameters: [AGENT_WORKER_TENANT],
					}),
				),
			).rejects.toMatchObject({ code: '42501' });
		} finally {
			await runtime.release();
		}
	});
});

describe('agents playground worker indicator', () => {
	beforeEach(() => {
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
	});

	afterEach(() => {
		setActiveLocale('en');
	});

	it('AGENTS-WORKER-AVAILABILITY shows each state distinctly in every locale', () => {
		const seen = Date.UTC(2026, 9, 5, 12, 30);
		const base = { leaseMs: 30_000, inFlight: 1 };
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			const indicators = [
				workerIndicator(null, true),
				workerIndicator(null, false),
				workerIndicator(
					{
						...base,
						state: 'online',
						online: true,
						concurrency: 3,
						lastHeartbeatAt: seen,
					},
					false,
				),
				workerIndicator(
					{
						...base,
						state: 'offline',
						online: false,
						concurrency: 0,
						lastHeartbeatAt: seen,
					},
					false,
				),
				workerIndicator(
					{
						...base,
						state: 'not-seen',
						online: false,
						concurrency: 0,
						lastHeartbeatAt: null,
					},
					false,
				),
			];
			expect(indicators.map((indicator) => indicator.state)).toEqual([
				'failed',
				'loading',
				'online',
				'offline',
				'not-seen',
			]);
			expect(indicators.map((indicator) => indicator.live)).toEqual([
				false,
				false,
				true,
				false,
				false,
			]);
			const labels = indicators.map((indicator) => indicator.label);
			expect(new Set(labels).size, locale).toBe(labels.length);
			for (const label of labels) {
				expect(label, locale).not.toMatch(/^agents\.|\{/);
			}
			expect(indicators[3]!.label).toContain(
				new Intl.DateTimeFormat(locale, {
					dateStyle: 'medium',
					timeStyle: 'short',
				}).format(seen),
			);
			expect(indicators[2]!.title).toMatch(/3/);
		}
		setActiveLocale('pl');
		const polish = workerIndicator(null, true).label;
		setActiveLocale('en');
		expect(workerIndicator(null, true).label).not.toBe(polish);
	});
});
