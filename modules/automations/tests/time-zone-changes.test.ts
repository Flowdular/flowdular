import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	createPlatformCapabilityRegistry,
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingChangesPage,
	type ModuleSettingChangesRequest,
	type ModuleSettingLogEntry,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import type { JobEvent } from '@flowdular/server';
import {
	AGENT_RUN_QUEUE_CAPABILITY,
	type AgentRunQueue,
} from '@flowdular/module-agents/server';
import {
	createModuleSettingsRuntime,
	type PlatformServerContext,
} from '@flowdular/module-auth/server';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createServerComposition } from '../src/platform.ts';
import { DatabaseAutomationsRepository } from '../src/services/database-repository.ts';
import type {
	AutomationsRepository,
	StoredAutomationSchedule,
} from '../src/services/repository.ts';
import {
	createAutomationScheduleRunner,
	SCHEDULE_HELD_SKIPS,
	SCHEDULE_POLL_PAGE,
} from '../src/services/schedule-runner.ts';
import { AutomationScheduleService } from '../src/services/schedule-service.ts';
import { createTimeZoneFollower } from '../src/services/time-zone-follower.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

/* Every process here, web or worker, reads settings through auth.core over the
   one database they share, so a zone change travels only the way it does in a
   deployment: committed by one process, read from the change log by another.
   Time is real, because the change log stamps changes with database time. */
let shared: AutomationsTestDatabase;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* An hourly cron slot at wall minute 0 lands on a different UTC minute in each
   zone, whatever the hour or the date: none of these observes daylight saving. */
const HOURLY = 'cron:0 * * * *';
const KOLKATA = 'Asia/Kolkata';
const KATHMANDU = 'Asia/Kathmandu';
const UTC_MINUTE: Readonly<Record<string, number>> = {
	UTC: 0,
	[KOLKATA]: 30,
	[KATHMANDU]: 15,
};

/** The first slot of HOURLY in `zone` strictly after `base`. */
function hourlySlotAfter(base: number, zone: string): number {
	const candidate = Math.floor(base / HOUR) * HOUR + UTC_MINUTE[zone]! * MINUTE;
	return candidate > base ? candidate : candidate + HOUR;
}

const OWNER_SETTINGS = defineModuleSettings({
	moduleId: TENANT_TIME_ZONE_SETTING.moduleId,
	settings: {
		[TENANT_TIME_ZONE_SETTING.key]: {
			type: 'string',
			defaultValue: TENANT_TIME_ZONE_SETTING.defaultValue,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			min: 1,
			max: 64,
		},
	},
});

const DEMO_SETTINGS = defineModuleSettings({
	moduleId: 'demo.core',
	settings: {
		apiKey: {
			type: 'string',
			defaultValue: '',
			visibility: 'private',
			client: false,
			secret: true,
			scope: 'tenant',
		},
		banner: {
			type: 'string',
			defaultValue: '',
			visibility: 'shared',
			client: false,
			scope: 'platform',
		},
	},
});

const disposals: (() => Promise<void>)[] = [];

beforeAll(async () => {
	shared = await openAutomationsTestDatabase();
	/* auth.core migrates its schema on the first read, so the tables the reset
	   empties exist before any case runs. */
	const probe = settingsProcess();
	await probe.changesAfter({ after: null, limit: 1 });
});

afterAll(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
	await shared?.dispose();
});

afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
	await shared.reset();
	await asAuthOwner((owner) =>
		owner.transaction(
			(transaction) =>
				transaction.execute({
					text: 'TRUNCATE module_settings, module_settings_changes, auth_audit RESTART IDENTITY',
				}),
			{ access: 'write' },
		),
	);
});

async function asAuthOwner<T>(
	body: (owner: DatabaseHandle) => Promise<T>,
): Promise<T> {
	const lease = await shared.databases.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
	});
	try {
		return await body(lease.database);
	} finally {
		await lease.release();
	}
}

/** A process's settings runtime over auth.core: its own snapshot and cursor. */
function settingsProcess(
	databases: DatabaseProvider = shared.databases,
): ModuleSettingsRuntime {
	const opened = createModuleSettingsRuntime({ databases, purpose: 'test' });
	disposals.push(() => opened.dispose());
	opened.settings.declare(OWNER_SETTINGS);
	opened.settings.declare(DEMO_SETTINGS);
	return opened.settings;
}

function setZone(
	web: ModuleSettingsRuntime,
	tenantId: string,
	zone: string,
): Promise<void> {
	return web.set(
		tenantId,
		TENANT_TIME_ZONE_SETTING.moduleId,
		TENANT_TIME_ZONE_SETTING.key,
		zone,
		`owner-${tenantId}`,
	);
}

/** The newest zone change of a workspace, as the log answers it. */
async function zoneChange(tenantId: string): Promise<ModuleSettingLogEntry> {
	const page = await settingsProcess().changesAfter({
		after: null,
		limit: 500,
		moduleId: TENANT_TIME_ZONE_SETTING.moduleId,
		key: TENANT_TIME_ZONE_SETTING.key,
	});
	if (page.expired) throw new Error('A read from the start expired.');
	const change = page.changes
		.filter((entry) => entry.tenantId === tenantId)
		.at(-1);
	if (!change) throw new Error(`No zone change of ${tenantId}.`);
	return change;
}

/* Stands for a change committed long before the worker read it. The row is
   auth.core's, so only this test reaches it, through auth.core's own owner. */
async function backdate(tenantId: string, changedAt: number): Promise<void> {
	await asAuthOwner((owner) =>
		owner.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE module_settings_changes SET changed_at = $2
					 WHERE tenant_id = $1 AND module_id = $3 AND key = $4`,
					parameters: [
						tenantId,
						changedAt,
						TENANT_TIME_ZONE_SETTING.moduleId,
						TENANT_TIME_ZONE_SETTING.key,
					],
				}),
			{ access: 'write', tenantId },
		),
	);
}

function schedule(
	tenantId: string,
	id: string,
	cadence: string,
	nextRunAt: number,
	overrides: Partial<StoredAutomationSchedule> = {},
): StoredAutomationSchedule {
	return {
		id,
		tenantId,
		targetKind: 'agent',
		targetKey: `${tenantId}-agent`,
		agentId: `${tenantId}-agent`,
		label: `Schedule ${id}`,
		inputTemplate: 'Summarize the day.',
		cadence,
		enabled: true,
		disabledReason: null,
		nextRunAt,
		lastRunAt: null,
		lastRunId: null,
		lastError: null,
		createdAt: 1,
		updatedAt: 1,
		createdBy: 'owner-1',
		configuredBy: { kind: 'user', id: 'owner-1', label: 'Owner' },
		permissionSnapshot: [AUTOMATIONS_PERMISSIONS.manage],
		...overrides,
	};
}

const nextRunOf = async (tenantId: string, id: string) =>
	(await shared.repository.getSchedule(tenantId, id))?.nextRunAt;

/** Oldest first. */
const retimed = async (tenantId: string) =>
	(await shared.repository.listAuditEvents(tenantId, 200))
		.filter((event) => event.action === 'automation-schedule.retimed')
		.reverse();

function runQueue(): {
	readonly queue: AgentRunQueue;
	readonly keys: string[];
} {
	const keys: string[] = [];
	const queue: AgentRunQueue = {
		listAgents: async (tenantId) => [
			{
				id: `${tenantId}-agent`,
				name: 'Workspace agent',
				status: 'active',
				allowedTools: [],
				revision: 1,
				ownership: { kind: 'tenant' },
			},
		],
		enqueue: async (_context, input) => {
			keys.push(input.idempotencyKey ?? 'unkeyed');
			return { id: `run-${keys.length}` } as Awaited<
				ReturnType<AgentRunQueue['enqueue']>
			>;
		},
		enqueueWithOutcome: async (context, input) => ({
			run: await queue.enqueue(context, input),
			created: true,
		}),
	};
	return { queue, keys };
}

interface WorkerProcess {
	readonly settings: ModuleSettingsRuntime;
	readonly composition: ReturnType<typeof createServerComposition>;
	/** Idempotency key of every run the worker enqueued. */
	readonly keys: string[];
	/** Every page the discovery read, in order. */
	readonly pages: ModuleSettingChangesPage[];
	readonly requests: ModuleSettingChangesRequest[];
	readonly writes: { count: number };
	readonly logReadsFail: { on: boolean };
	/** From now on the log answers every cursor it issued so far as past retention. */
	readonly expireCursors: () => void;
}

/**
 * One platform process composing automations.core over its own settings
 * runtime. A settings callback is refused outright: no zone may reach the
 * scheduler that way.
 */
async function workerProcess(
	options: {
		readonly databases?: DatabaseProvider;
		readonly before?: (settings: ModuleSettingsRuntime) => Promise<void>;
	} = {},
): Promise<WorkerProcess> {
	const real = settingsProcess();
	await options.before?.(real);
	const pages: ModuleSettingChangesPage[] = [];
	const requests: ModuleSettingChangesRequest[] = [];
	const writes = { count: 0 };
	const logReadsFail = { on: false };
	const issued = new Set<string>();
	const expired = new Set<string>();
	const settings = new Proxy(real, {
		get(target, property) {
			if (property === 'onChange') {
				return () => {
					throw new Error(
						'automations.core subscribed to a settings callback.',
					);
				};
			}
			if (property === 'set') {
				return (...args: Parameters<ModuleSettingsRuntime['set']>) => {
					writes.count += 1;
					return target.set(...args);
				};
			}
			if (property === 'changesAfter') {
				return async (request: ModuleSettingChangesRequest) => {
					requests.push(request);
					if (logReadsFail.on) throw new Error('connection lost');
					if (request.after !== null && expired.has(request.after)) {
						return { expired: true } as const;
					}
					const page = await target.changesAfter(request);
					pages.push(page);
					if (!page.expired) issued.add(page.cursor);
					return page;
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const capabilities = createPlatformCapabilityRegistry();
	const { queue, keys } = runQueue();
	capabilities.register(AGENT_RUN_QUEUE_CAPABILITY, queue);
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: {},
		settings,
		databases: options.databases ?? shared.databases,
		dataClasses: { declare: () => {} },
		agentTools: { register: () => {} },
		agentDefinitions: { register: () => {} },
		capabilities,
	};
	const composition = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	disposals.push(async () => {
		await composition.dispose?.();
	});
	return {
		settings: real,
		composition,
		keys,
		pages,
		requests,
		writes,
		logReadsFail,
		expireCursors: () => {
			for (const cursor of issued) expired.add(cursor);
		},
	};
}

let canaries = 0;

/**
 * One whole scheduler pass of a stopped worker. A due interval schedule in a
 * workspace of its own sorts after every schedule due before it, so once it
 * fired the pass has applied its zone changes and passed every older slot.
 * That holds because every pass here reaches the end of the due rows, so the
 * next one walks from the oldest again.
 */
async function runPass(worker: WorkerProcess): Promise<void> {
	canaries += 1;
	const id = `canary-${canaries}`;
	const slot = Date.now();
	await shared.repository.createSchedule(
		schedule('tenant-canary', id, 'every:60', slot),
	);
	worker.composition.startWorker?.();
	await vi.waitFor(
		() => expect(worker.keys).toContain(`schedule:${id}:${slot}`),
		{ timeout: 10_000, interval: 10 },
	);
	await worker.composition.stop?.();
}

const firedSlots = (worker: WorkerProcess, id: string): number[] =>
	worker.keys
		.filter((key) => key.startsWith(`schedule:${id}:`))
		.map((key) => Number(key.slice(`schedule:${id}:`.length)));

/* The lease the automations runtime takes for tenant work, with the next write
   transaction of a workspace failing once after all its statements ran, the
   way a connection lost at commit fails it. */
function failingWrites(databases: DatabaseProvider): {
	readonly provider: DatabaseProvider;
	readonly failNext: Set<string>;
} {
	const failNext = new Set<string>();
	const wrap = (handle: DatabaseHandle): DatabaseHandle =>
		new Proxy(handle, {
			get(target, property) {
				if (property === 'transaction') {
					return (
						operation: Parameters<DatabaseHandle['transaction']>[0],
						options?: Parameters<DatabaseHandle['transaction']>[1],
					) => {
						const tenantId = options?.tenantId;
						if (
							options?.access === 'write' &&
							tenantId !== undefined &&
							failNext.delete(tenantId)
						) {
							return target.transaction(async (transaction) => {
								await operation(transaction);
								throw new Error('connection reset');
							}, options);
						}
						return target.transaction(operation, options);
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	const provider: DatabaseProvider = {
		acquire: async (request) => {
			const lease: DatabaseAdapterLease = await databases.acquire(request);
			if (
				request.namespace !== 'automations.core' ||
				request.purpose !== 'test'
			) {
				return lease;
			}
			return { database: wrap(lease.database), release: () => lease.release() };
		},
		dispose: async () => undefined,
	};
	return { provider, failNext };
}

/** The shared repository with some of its methods replaced. */
function repositoryWith(
	overrides: Partial<AutomationsRepository>,
): AutomationsRepository {
	return new Proxy(shared.repository, {
		get(target, property) {
			if (Object.hasOwn(overrides, property)) {
				return overrides[property as keyof AutomationsRepository];
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/**
 * The scheduler of one worker driven a pass at a time, its zone discovery
 * reading the change log through a settings runtime of its own. The log reads
 * fail until the case turns them back on.
 */
function directScheduler(
	repository: AutomationsRepository = shared.repository,
) {
	const settings = settingsProcess();
	const { queue, keys } = runQueue();
	const service = new AutomationScheduleService(
		repository,
		queue,
		Date.now,
		undefined,
		undefined,
		undefined,
		settings,
	);
	const logReadsFail = { on: true };
	const events: JobEvent[] = [];
	const runner = createAutomationScheduleRunner({
		repository: async () => repository,
		service: async () => service,
		timeZones: createTimeZoneFollower({
			settings: {
				changesAfter: async (request) => {
					if (logReadsFail.on) throw new Error('connection lost');
					return settings.changesAfter(request);
				},
			},
			apply: (change) => service.applyTimeZoneChange(change),
		}),
		intervalMs: 30_000,
		onEvent: (event) => events.push(event),
	});
	return { runner, keys, events, logReadsFail };
}

/* A web process that dies the moment its next write commits: the commit lands,
   and nothing it would have done afterwards runs. */
function dyingAfterNextWrite(databases: DatabaseProvider): {
	readonly provider: DatabaseProvider;
	readonly arm: () => void;
} {
	let armed = false;
	let dead = false;
	const wrap = (handle: DatabaseHandle): DatabaseHandle =>
		new Proxy(handle, {
			get(target, property) {
				const value = Reflect.get(target, property, target) as unknown;
				if (typeof value !== 'function') return value;
				return async (...args: unknown[]) => {
					if (dead) throw new Error('The web process is gone.');
					const options = args[1] as
						| Parameters<DatabaseHandle['transaction']>[1]
						| undefined;
					const result = (await value.apply(target, args)) as unknown;
					if (
						property === 'transaction' &&
						armed &&
						options?.access === 'write'
					) {
						dead = true;
						throw new Error('The web process died after its commit.');
					}
					return result;
				};
			},
		});
	return {
		provider: {
			acquire: async (request) => {
				const lease = await databases.acquire(request);
				return {
					database: wrap(lease.database),
					release: () => lease.release(),
				};
			},
			dispose: async () => undefined,
		},
		arm: () => {
			armed = true;
		},
	};
}

describe('workspace time zone changes through the settings change log', () => {
	it('AUTO-WORKER-TIME-ZONE moves a cron slot by the first pass after the commit, before an old-zone slot fires, including after a restart', async () => {
		const pending = hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC');
		const interval = Date.now() + 7 * DAY;
		await shared.repository.createSchedule(
			schedule('tenant-a', 'hourly', HOURLY, pending),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'interval', 'every:10080', interval),
		);
		const web = settingsProcess();
		let worker = await workerProcess({
			before: (settings) => settings.prime('tenant-a'),
		});
		await runPass(worker);

		await setZone(web, 'tenant-a', KOLKATA);
		const change = await zoneChange('tenant-a');
		/* An old-zone slot that comes due right after the change. */
		const stored = await shared.repository.getSchedule('tenant-a', 'hourly');
		await shared.repository.updateSchedule({
			...stored!,
			nextRunAt: change.changedAt + 1,
		});
		await vi.waitFor(() =>
			expect(Date.now()).toBeGreaterThan(change.changedAt + 1),
		);

		await runPass(worker);
		expect(firedSlots(worker, 'hourly')).toEqual([]);
		expect(await nextRunOf('tenant-a', 'hourly')).toBe(
			hourlySlotAfter(change.changedAt, KOLKATA),
		);
		expect(await nextRunOf('tenant-a', 'interval')).toBe(interval);
		expect(await shared.repository.appliedTimeZone('tenant-a')).toMatchObject({
			revision: change.revision,
			changedAt: change.changedAt,
		});
		const columns = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ column_name: string }>({
					text: `SELECT column_name FROM information_schema.columns
					 WHERE table_schema = current_schema()
					   AND table_name = 'automations_time_zones'
					 ORDER BY column_name`,
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			'applied_at',
			'applied_revision',
			'changed_at',
			'tenant_id',
		]);

		/* A restarted worker holds no cursor and reads the log from its start. */
		await worker.composition.dispose?.();
		await setZone(web, 'tenant-a', KATHMANDU);
		const second = await zoneChange('tenant-a');
		worker = await workerProcess();
		await runPass(worker);
		expect(await nextRunOf('tenant-a', 'hourly')).toBe(
			hourlySlotAfter(second.changedAt, KATHMANDU),
		);
		expect(await nextRunOf('tenant-a', 'interval')).toBe(interval);
		expect(
			(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
		).toBe(second.revision);
		expect(worker.writes.count).toBe(0);
	});

	it('AUTO-TZ-ACCEPTOR-CRASH retimes a change whose web process died right after the commit', async () => {
		await shared.repository.createSchedule(
			schedule(
				'tenant-a',
				'hourly',
				HOURLY,
				hourlySlotAfter(Date.now() + HOUR, 'UTC'),
			),
		);
		const worker = await workerProcess();
		await runPass(worker);

		const dying = dyingAfterNextWrite(shared.databases);
		const web = settingsProcess(dying.provider);
		await web.prime('tenant-a');
		dying.arm();
		await expect(setZone(web, 'tenant-a', KOLKATA)).rejects.toThrow(
			'died after its commit',
		);
		const change = await zoneChange('tenant-a');
		const stored = await shared.repository.getSchedule('tenant-a', 'hourly');
		await shared.repository.updateSchedule({
			...stored!,
			nextRunAt: change.changedAt + 1,
		});
		await vi.waitFor(() =>
			expect(Date.now()).toBeGreaterThan(change.changedAt + 1),
		);

		await runPass(worker);
		expect(firedSlots(worker, 'hourly')).toEqual([]);
		expect(await nextRunOf('tenant-a', 'hourly')).toBe(
			hourlySlotAfter(change.changedAt, KOLKATA),
		);
		expect(
			(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
		).toBe(change.revision);
	});

	it('AUTO-TZ-TWO-CHANGES applies only the newest of two changes made while the worker was stopped', async () => {
		await shared.repository.createSchedule(
			schedule(
				'tenant-a',
				'hourly',
				HOURLY,
				hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC'),
			),
		);
		const worker = await workerProcess();
		await runPass(worker);

		const web = settingsProcess();
		await setZone(web, 'tenant-a', KATHMANDU);
		await setZone(web, 'tenant-a', KOLKATA);
		const newest = await zoneChange('tenant-a');

		await runPass(worker);
		expect(await nextRunOf('tenant-a', 'hourly')).toBe(
			hourlySlotAfter(newest.changedAt, KOLKATA),
		);
		expect(
			(await retimed('tenant-a')).map((event) => event.metadata.timeZone),
		).toEqual([KOLKATA]);
		expect(
			(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
		).toBe(newest.revision);
	});

	it('AUTO-TZ-REPLAY moves nothing when an applied change is read again by a later pass or a restarted worker', async () => {
		const web = settingsProcess();
		await setZone(web, 'tenant-a', KOLKATA);
		/* Applied late enough that the slot it moves to is already due, so the
		   same pass fires it. */
		await backdate('tenant-a', Date.now() - 2 * HOUR);
		const change = await zoneChange('tenant-a');
		await shared.repository.createSchedule(
			schedule(
				'tenant-a',
				'hourly',
				HOURLY,
				hourlySlotAfter(Date.now() + HOUR, 'UTC'),
			),
		);
		const worker = await workerProcess();
		await runPass(worker);
		const moved = hourlySlotAfter(change.changedAt, KOLKATA);
		expect(firedSlots(worker, 'hourly')).toEqual([moved]);
		const next = (await nextRunOf('tenant-a', 'hourly'))!;
		expect(next).toBeGreaterThan(moved);
		const applied = await shared.repository.appliedTimeZone('tenant-a');
		expect(applied?.revision).toBe(change.revision);
		const events = await retimed('tenant-a');
		expect(events).toHaveLength(1);

		worker.expireCursors();
		await runPass(worker);
		expect(
			worker.requests.filter((request) => request.after === null),
		).toHaveLength(2);
		const restarted = await workerProcess();
		await runPass(restarted);

		expect(await nextRunOf('tenant-a', 'hourly')).toBe(next);
		expect(await retimed('tenant-a')).toEqual(events);
		expect(await shared.repository.appliedTimeZone('tenant-a')).toEqual(
			applied,
		);
		expect(firedSlots(worker, 'hourly')).toEqual([moved]);
		expect(firedSlots(restarted, 'hourly')).toEqual([]);
	});

	it('AUTO-TZ-REPLAY owes no slot again that fired or was computed after the change when the change is applied late', async () => {
		const now = Date.now();
		const web = settingsProcess();
		await setZone(web, 'tenant-a', KOLKATA);
		await backdate('tenant-a', now - 3 * HOUR);
		const change = await zoneChange('tenant-a');
		const firedAt = now - 2 * HOUR;
		const savedAt = now - 90 * MINUTE;
		const pending = hourlySlotAfter(now + HOUR, 'UTC');
		await shared.repository.createSchedule(
			schedule('tenant-a', 'fired', HOURLY, pending, { lastRunAt: firedAt }),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'saved', HOURLY, pending, { updatedAt: savedAt }),
		);
		const worker = await workerProcess();
		await runPass(worker);

		/* Each moves to its first slot after the later of the change and its own
		   run or save, which is already due, so the pass fires it once. */
		expect(firedSlots(worker, 'fired')).toEqual([
			hourlySlotAfter(firedAt, KOLKATA),
		]);
		expect(firedSlots(worker, 'saved')).toEqual([
			hourlySlotAfter(savedAt, KOLKATA),
		]);
		expect(hourlySlotAfter(change.changedAt, KOLKATA)).toBeLessThan(firedAt);
	});

	it('AUTO-TZ-RETIME-FAILS holds the cron slots of a workspace whose retiming failed and retries it next pass', async () => {
		const owed = Date.now() - MINUTE;
		for (const tenantId of ['tenant-a', 'tenant-b']) {
			await shared.repository.createSchedule(
				schedule(tenantId, `${tenantId}-hourly`, HOURLY, owed),
			);
		}
		await shared.repository.createSchedule(
			schedule('tenant-b', 'tenant-b-interval', 'every:60', owed),
		);
		const pending = hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC');
		await shared.repository.createSchedule(
			schedule('tenant-b', 'tenant-b-pending', HOURLY, pending),
		);
		const web = settingsProcess();
		await setZone(web, 'tenant-a', KOLKATA);
		await setZone(web, 'tenant-b', KATHMANDU);
		const changeA = await zoneChange('tenant-a');
		const changeB = await zoneChange('tenant-b');
		const faults = failingWrites(shared.databases);
		const worker = await workerProcess({ databases: faults.provider });
		faults.failNext.add('tenant-b');

		await runPass(worker);
		/* A slot due by the change keeps its fire, in the workspace whose
		   retiming landed; the next one is computed in its new zone. */
		expect(firedSlots(worker, 'tenant-a-hourly')).toEqual([owed]);
		expect(
			new Date(
				(await nextRunOf('tenant-a', 'tenant-a-hourly'))!,
			).getUTCMinutes(),
		).toBe(UTC_MINUTE[KOLKATA]);
		expect(
			(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
		).toBe(changeA.revision);
		expect(firedSlots(worker, 'tenant-b-hourly')).toEqual([]);
		expect(firedSlots(worker, 'tenant-b-interval')).toEqual([owed]);
		/* Nothing of the failed retiming stayed: no moved slot, no event, no
		   applied revision. */
		expect(await shared.repository.appliedTimeZone('tenant-b')).toBeNull();
		expect(await nextRunOf('tenant-b', 'tenant-b-hourly')).toBe(owed);
		expect(await nextRunOf('tenant-b', 'tenant-b-pending')).toBe(pending);
		expect(await retimed('tenant-b')).toEqual([]);

		await runPass(worker);
		expect(await nextRunOf('tenant-b', 'tenant-b-pending')).toBe(
			hourlySlotAfter(changeB.changedAt, KATHMANDU),
		);
		expect(
			(await shared.repository.appliedTimeZone('tenant-b'))?.revision,
		).toBe(changeB.revision);
		expect(firedSlots(worker, 'tenant-b-hourly')).toEqual([owed]);
		expect(
			new Date(
				(await nextRunOf('tenant-b', 'tenant-b-hourly'))!,
			).getUTCMinutes(),
		).toBe(UTC_MINUTE[KATHMANDU]);
		expect(firedSlots(worker, 'tenant-a-hourly')).toEqual([owed]);
	});

	it('AUTO-TZ-RETIME-FAILS holds every cron slot in a pass that could not read the change log', async () => {
		const owed = Date.now() - MINUTE;
		await shared.repository.createSchedule(
			schedule('tenant-a', 'hourly', HOURLY, owed),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'interval', 'every:60', owed),
		);
		await setZone(settingsProcess(), 'tenant-a', KOLKATA);
		const change = await zoneChange('tenant-a');
		const worker = await workerProcess();
		worker.logReadsFail.on = true;

		await runPass(worker);
		expect(firedSlots(worker, 'hourly')).toEqual([]);
		expect(firedSlots(worker, 'interval')).toEqual([owed]);
		expect(await shared.repository.appliedTimeZone('tenant-a')).toBeNull();

		worker.logReadsFail.on = false;
		await runPass(worker);
		expect(
			(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
		).toBe(change.revision);
		expect(firedSlots(worker, 'hourly')).toEqual([owed]);
	});

	it('AUTO-TZ-RETIME-FAILS fires the other workspace in that pass however many held cron slots sort ahead of it', async () => {
		const owed = Date.now() - HOUR;
		const held = Array.from(
			{ length: SCHEDULE_POLL_PAGE + 5 },
			(_, index) => `tenant-b-hourly-${index}`,
		);
		for (const [index, id] of held.entries()) {
			await shared.repository.createSchedule(
				schedule('tenant-b', id, HOURLY, owed + index),
			);
		}
		const behind = owed + held.length;
		await shared.repository.createSchedule(
			schedule('tenant-b', 'tenant-b-interval', 'every:60', behind),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'tenant-a-hourly', HOURLY, behind),
		);
		const web = settingsProcess();
		await setZone(web, 'tenant-a', KOLKATA);
		await setZone(web, 'tenant-b', KATHMANDU);
		const faults = failingWrites(shared.databases);
		const worker = await workerProcess({ databases: faults.provider });
		faults.failNext.add('tenant-b');

		await runPass(worker);
		expect(firedSlots(worker, 'tenant-a-hourly')).toEqual([behind]);
		expect(firedSlots(worker, 'tenant-b-interval')).toEqual([behind]);
		for (const id of held) expect(firedSlots(worker, id)).toEqual([]);
		expect(await shared.repository.appliedTimeZone('tenant-b')).toBeNull();
	});

	it('AUTO-TZ-RETIME-FAILS fires interval schedules in a pass that could not read the change log however many cron slots it holds', async () => {
		const owed = Date.now() - HOUR;
		const held = Array.from(
			{ length: SCHEDULE_POLL_PAGE + 5 },
			(_, index) => `hourly-${index}`,
		);
		for (const [index, id] of held.entries()) {
			await shared.repository.createSchedule(
				schedule(index % 2 ? 'tenant-a' : 'tenant-b', id, HOURLY, owed + index),
			);
		}
		const behind = owed + held.length;
		await shared.repository.createSchedule(
			schedule('tenant-a', 'interval', 'every:60', behind),
		);
		const worker = await workerProcess();
		worker.logReadsFail.on = true;

		await runPass(worker);
		expect(firedSlots(worker, 'interval')).toEqual([behind]);
		for (const id of held) expect(firedSlots(worker, id)).toEqual([]);
	});

	it('AUTO-TZ-RETIME-FAILS reaches a slot behind more held cron slots than one pass steps over by the next pass, then walks again from the oldest', async () => {
		const owed = Date.now() - HOUR;
		const held = SCHEDULE_HELD_SKIPS + SCHEDULE_POLL_PAGE + 5;
		for (let index = 0; index < held; index += 1) {
			await shared.repository.createSchedule(
				schedule('tenant-a', `hourly-${index}`, HOURLY, owed + index),
			);
		}
		await shared.repository.createSchedule(
			schedule('tenant-b', 'interval', 'every:60', owed + held),
		);
		const reads = { count: 0 };
		const { runner, keys, logReadsFail } = directScheduler(
			repositoryWith({
				getSchedule: (tenantId, scheduleId) => {
					reads.count += 1;
					return shared.repository.getSchedule(tenantId, scheduleId);
				},
			}),
		);

		await runner.tick();
		/* A pass under a hold that never lifts still ends: it reads no more
		   schedules than it steps over and claims. */
		expect(reads.count).toBeLessThanOrEqual(
			SCHEDULE_HELD_SKIPS + SCHEDULE_POLL_PAGE,
		);
		await runner.tick();
		expect(keys).toEqual([`schedule:interval:${owed + held}`]);

		logReadsFail.on = false;
		await runner.tick();
		expect(keys.slice(1)).toEqual(
			Array.from(
				{ length: SCHEDULE_POLL_PAGE },
				(_, index) => `schedule:hourly-${index}:${owed + index}`,
			),
		);
	});

	it('AUTO-TZ-RETIME-FAILS reads zone changes again in the pass after one whose poll failed midway', async () => {
		const owed = Date.now() - HOUR;
		const held = SCHEDULE_POLL_PAGE + 5;
		for (let index = 0; index < held; index += 1) {
			await shared.repository.createSchedule(
				schedule('tenant-a', `hourly-${index}`, HOURLY, owed + index),
			);
		}
		let polls = 0;
		const { runner, keys, logReadsFail } = directScheduler(
			repositoryWith({
				listDueSchedules: (...args) => {
					polls += 1;
					if (polls === 2) throw new Error('connection lost');
					return shared.repository.listDueSchedules(...args);
				},
			}),
		);

		await runner.tick();
		expect(keys).toEqual([]);

		/* The log reads again, so the next pass holds nothing and fires the
		   slots past the row the failed one stopped after. */
		logReadsFail.on = false;
		await runner.tick();
		expect(keys).toEqual(
			Array.from(
				{ length: held - SCHEDULE_POLL_PAGE },
				(_, index) =>
					`schedule:hourly-${SCHEDULE_POLL_PAGE + index}:${owed + SCHEDULE_POLL_PAGE + index}`,
			),
		);
	});

	it('AUTO-TZ-RETIME-FAILS claims a held slot it cannot read, so its failure is reported and the pass goes on', async () => {
		const owed = Date.now() - HOUR;
		await shared.repository.createSchedule(
			schedule('tenant-a', 'unreadable', HOURLY, owed),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'hourly', HOURLY, owed + 1),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'interval', 'every:60', owed + 2),
		);
		const { runner, keys, events } = directScheduler(
			repositoryWith({
				getSchedule: async (tenantId, scheduleId) => {
					if (scheduleId === 'unreadable') {
						throw new Error('connection lost');
					}
					return shared.repository.getSchedule(tenantId, scheduleId);
				},
			}),
		);

		await runner.tick();
		expect(events.filter((event) => event.type === 'item-failed')).toHaveLength(
			1,
		);
		expect(keys).toEqual([`schedule:interval:${owed + 2}`]);
	});

	it('AUTO-TZ-RESYNC reads the log from its start once the cursor expired and retimes a change older than the retention period', async () => {
		const web = settingsProcess();
		const pending = hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC');
		for (const tenantId of ['tenant-a', 'tenant-b', 'tenant-c']) {
			await shared.repository.createSchedule(
				schedule(tenantId, `${tenantId}-hourly`, HOURLY, pending),
			);
		}
		await setZone(web, 'tenant-c', KOLKATA);
		const worker = await workerProcess();
		await runPass(worker);
		const appliedC = await shared.repository.appliedTimeZone('tenant-c');
		const movedC = await nextRunOf('tenant-c', 'tenant-c-hourly');
		expect(movedC).not.toBe(pending);
		const eventsC = await retimed('tenant-c');

		await setZone(web, 'tenant-a', KATHMANDU);
		await backdate('tenant-a', Date.now() - 40 * DAY);
		const changeA = await zoneChange('tenant-a');
		const savedAt = Date.now();
		const stored = await shared.repository.getSchedule(
			'tenant-a',
			'tenant-a-hourly',
		);
		await shared.repository.updateSchedule({ ...stored!, updatedAt: savedAt });

		worker.expireCursors();
		await runPass(worker);
		expect(await nextRunOf('tenant-a', 'tenant-a-hourly')).toBe(
			hourlySlotAfter(savedAt, KATHMANDU),
		);
		expect(await shared.repository.appliedTimeZone('tenant-a')).toMatchObject({
			revision: changeA.revision,
			changedAt: changeA.changedAt,
		});
		expect(await nextRunOf('tenant-c', 'tenant-c-hourly')).toBe(movedC);
		expect(await retimed('tenant-c')).toEqual(eventsC);
		expect(await shared.repository.appliedTimeZone('tenant-c')).toEqual(
			appliedC,
		);
		expect(await nextRunOf('tenant-b', 'tenant-b-hourly')).toBe(pending);
		expect(await shared.repository.appliedTimeZone('tenant-b')).toBeNull();
	});

	it('AUTO-TZ-NOT-COMPOSED converges a zone changed while automations.core was not composed', async () => {
		const owed = Date.now() - MINUTE;
		const pending = hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC');
		await shared.repository.createSchedule(
			schedule('tenant-a', 'owed', HOURLY, owed),
		);
		await shared.repository.createSchedule(
			schedule('tenant-a', 'pending', HOURLY, pending),
		);
		await setZone(settingsProcess(), 'tenant-a', KOLKATA);
		const change = await zoneChange('tenant-a');

		const worker = await workerProcess();
		await runPass(worker);
		expect(await nextRunOf('tenant-a', 'pending')).toBe(
			hourlySlotAfter(change.changedAt, KOLKATA),
		);
		expect(firedSlots(worker, 'owed')).toEqual([owed]);
		const next = (await nextRunOf('tenant-a', 'owed'))!;
		expect(new Date(next).getUTCMinutes()).toBe(UTC_MINUTE[KOLKATA]);
		expect(next - Date.now()).toBeLessThanOrEqual(HOUR);
	});

	it('AUTO-TZ-NOT-COMPOSED computes a fired slot in the setting even where the process snapshot predates the change', async () => {
		const owed = Date.now() - MINUTE;
		await shared.repository.createSchedule(
			schedule('tenant-a', 'owed', HOURLY, owed),
		);
		/* This worker read the zone before the change, well inside the
		   staleness bound, and another replica applies the change. */
		const worker = await workerProcess({
			before: (settings) => settings.prime('tenant-a'),
		});
		await setZone(settingsProcess(), 'tenant-a', KOLKATA);
		const change = await zoneChange('tenant-a');
		const replica = new AutomationScheduleService(
			shared.repository,
			runQueue().queue,
			Date.now,
			undefined,
			undefined,
			undefined,
			settingsProcess(),
		);
		expect(await replica.applyTimeZoneChange(change)).toBe(0);

		await runPass(worker);
		expect(firedSlots(worker, 'owed')).toEqual([owed]);
		expect(
			new Date((await nextRunOf('tenant-a', 'owed'))!).getUTCMinutes(),
		).toBe(UTC_MINUTE[KOLKATA]);
	});

	it('AUTO-TZ-DISCOVERY-NARROW discovers only zone changes, without values, actors or origins, and retimes each workspace alone', async () => {
		const pending = hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC');
		for (const tenantId of ['tenant-a', 'tenant-b']) {
			await shared.repository.createSchedule(
				schedule(tenantId, `${tenantId}-hourly`, HOURLY, pending),
			);
		}
		const web = settingsProcess();
		await setZone(web, 'tenant-a', KOLKATA);
		await web.set(
			'tenant-a',
			'demo.core',
			'apiKey',
			'sk-live-secret',
			'owner-tenant-a',
		);
		await setZone(web, 'tenant-b', KATHMANDU);
		await web.set(
			PLATFORM_SETTINGS_TENANT,
			'demo.core',
			'banner',
			'Maintenance tonight',
			'owner-platform',
		);
		const changeA = await zoneChange('tenant-a');
		const changeB = await zoneChange('tenant-b');

		const worker = await workerProcess();
		await runPass(worker);
		expect(worker.requests.length).toBeGreaterThan(0);
		for (const request of worker.requests) {
			expect(request).toMatchObject({
				moduleId: TENANT_TIME_ZONE_SETTING.moduleId,
				key: TENANT_TIME_ZONE_SETTING.key,
			});
		}
		const seen = worker.pages.flatMap((page) =>
			page.expired ? [] : page.changes,
		);
		expect(seen.map((change) => change.tenantId).sort()).toEqual([
			'tenant-a',
			'tenant-b',
		]);
		for (const change of seen) {
			expect(Object.keys(change).sort()).toEqual([
				'changedAt',
				'cleared',
				'key',
				'moduleId',
				'revision',
				'tenantId',
			]);
		}
		const answered = JSON.stringify(worker.pages);
		for (const hidden of [
			KOLKATA,
			KATHMANDU,
			'sk-live-secret',
			'Maintenance tonight',
			'owner-tenant-a',
			'owner-tenant-b',
		]) {
			expect(answered).not.toContain(hidden);
		}
		expect(worker.writes.count).toBe(0);

		expect(await nextRunOf('tenant-a', 'tenant-a-hourly')).toBe(
			hourlySlotAfter(changeA.changedAt, KOLKATA),
		);
		expect(await nextRunOf('tenant-b', 'tenant-b-hourly')).toBe(
			hourlySlotAfter(changeB.changedAt, KATHMANDU),
		);
		expect((await retimed('tenant-a')).map((event) => event.subjectId)).toEqual(
			['tenant-a-hourly'],
		);
		expect((await retimed('tenant-b')).map((event) => event.subjectId)).toEqual(
			['tenant-b-hourly'],
		);
	});
});

/* Two replicas only race for real on separate connections; the embedded
   engine serves one at a time. */
describe.skipIf(process.env.FD_TEST_DATABASE_ADAPTER !== 'postgresql')(
	'AUTO-TZ-REPLAY',
	() => {
		const replica = (runtime: DatabaseHandle) =>
			new AutomationScheduleService(
				new DatabaseAutomationsRepository({
					runtime,
					background: shared.background,
				}),
				runQueue().queue,
				Date.now,
				undefined,
				undefined,
				undefined,
				settingsProcess(),
			);

		const ownLease = async () => {
			const lease = await shared.databases.acquire({
				namespace: 'automations.core',
				purpose: 'test',
			});
			disposals.push(() => lease.release());
			return lease.database;
		};

		const waitingFor = (count: number) =>
			vi.waitFor(
				async () => {
					const waiting = await shared.runtime.transaction(
						(transaction) =>
							transaction.query<{ waiting: number }>({
								text: 'SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted',
							}),
						{ access: 'read', tenantId: 'tenant-a' },
					);
					expect(waiting.rows[0]?.waiting).toBeGreaterThanOrEqual(count);
				},
				{ timeout: 5_000, interval: 20 },
			);

		function gate() {
			let open!: () => void;
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { open, opened };
		}

		it('serialises two replicas applying the same change on the workspace applied record', async () => {
			const web = settingsProcess();
			await shared.repository.createSchedule(
				schedule(
					'tenant-a',
					'hourly',
					HOURLY,
					hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC'),
				),
			);
			const arrived = gate();
			const release = gate();
			let armed = false;
			/* Holds its write transaction open after its last statement. */
			const paused: DatabaseHandle = new Proxy(shared.runtime, {
				get(target, property) {
					if (property === 'transaction') {
						return (
							operation: Parameters<DatabaseHandle['transaction']>[0],
							options?: Parameters<DatabaseHandle['transaction']>[1],
						) =>
							target.transaction(async (transaction) => {
								const value = await operation(transaction);
								if (armed && options?.access === 'write') {
									armed = false;
									arrived.open();
									await release.opened;
								}
								return value;
							}, options);
					}
					const value = Reflect.get(target, property, target) as unknown;
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
			const first = replica(paused);
			const second = replica(await ownLease());

			await setZone(web, 'tenant-a', KATHMANDU);
			expect(
				await second.applyTimeZoneChange(await zoneChange('tenant-a')),
			).toBe(1);
			await setZone(web, 'tenant-a', KOLKATA);
			const change = await zoneChange('tenant-a');

			armed = true;
			const applying = first.applyTimeZoneChange(change);
			await arrived.opened;
			const racing = second.applyTimeZoneChange(change);
			await waitingFor(1);
			release.open();

			expect(await Promise.all([applying, racing])).toEqual([1, null]);
			expect(
				(await retimed('tenant-a')).map((event) => event.metadata.timeZone),
			).toEqual([KATHMANDU, KOLKATA]);
			expect(
				(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
			).toBe(change.revision);
			expect(await nextRunOf('tenant-a', 'hourly')).toBe(
				hourlySlotAfter(change.changedAt, KOLKATA),
			);
		});

		it('never lets a replica applying an older change record it over a newer one in flight', async () => {
			const web = settingsProcess();
			await shared.repository.createSchedule(
				schedule(
					'tenant-a',
					'hourly',
					HOURLY,
					hourlySlotAfter(Date.now() + 2 * HOUR, 'UTC'),
				),
			);
			const newer = replica(await ownLease());
			const older = replica(await ownLease());
			await setZone(web, 'tenant-a', KOLKATA);
			expect(
				await older.applyTimeZoneChange(await zoneChange('tenant-a')),
			).toBe(1);
			await setZone(web, 'tenant-a', KATHMANDU);
			const second = await zoneChange('tenant-a');
			await setZone(web, 'tenant-a', 'UTC');
			const third = await zoneChange('tenant-a');

			/* A lock on the schedule row stops the newer retiming between reading
			   the applied record and writing it. */
			const holder = await ownLease();
			const locked = gate();
			const unlock = gate();
			const holding = holder.transaction(
				async (transaction) => {
					await transaction.query({
						text: `SELECT id FROM automations_schedules
						 WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
						parameters: ['tenant-a', 'hourly'],
					});
					locked.open();
					await unlock.opened;
				},
				{ access: 'write', tenantId: 'tenant-a' },
			);
			await locked.opened;
			const applyingNewer = newer.applyTimeZoneChange(third);
			await waitingFor(1);
			const applyingOlder = older.applyTimeZoneChange(second);
			await waitingFor(2);
			unlock.open();
			await holding;

			expect(await Promise.all([applyingNewer, applyingOlder])).toEqual([
				1,
				null,
			]);
			expect(
				(await shared.repository.appliedTimeZone('tenant-a'))?.revision,
			).toBe(third.revision);
			expect(await nextRunOf('tenant-a', 'hourly')).toBe(
				hourlySlotAfter(third.changedAt, 'UTC'),
			);
		});
	},
);
