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
import type { DatabaseProvider } from '@flowdular/database';
import {
	createModuleSettingsRuntime,
	createPlatformCapabilityRegistry,
	defineModuleSettings,
	userActor,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import {
	AGENT_RUN_QUEUE_CAPABILITY,
	type AgentRunQueue,
} from '@flowdular/module-agents/server';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	AUTOMATION_EXECUTION_CAPABILITY,
	type AutomationExecutionCapability,
} from '../src/server/execution.ts';
import type { StoredAutomationSchedule } from '../src/services/repository.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import {
	AutomationTriggerService,
	TRIGGER_SIGNATURE_HEADER,
	TRIGGER_TIMESTAMP_HEADER,
	triggerSignature,
	triggerSignedPayload,
} from '../src/services/trigger-service.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

/* One embedded engine stands in for the database a web process and a worker
   process share; everything else, settings snapshots included, is per process. */
let shared: AutomationsTestDatabase;

beforeAll(async () => {
	shared = await openAutomationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	vi.useRealTimers();
	await shared.reset();
});

const at = (iso: string): number => Date.parse(iso);

/* Settings storage outlives every process; each process primes its own
   snapshot from it, as the platform's settings runtime does. */
function settingsStore(): ModuleSettingsStore {
	const values = new Map<string, Record<string, ModuleSettingValue>>();
	const keyOf = (tenantId: string, moduleId: string) =>
		`${tenantId} ${moduleId}`;
	return {
		load: async (tenantId, moduleId) => ({
			...values.get(keyOf(tenantId, moduleId)),
		}),
		save: async (record) => {
			const key = keyOf(record.tenantId, record.moduleId);
			values.set(key, { ...values.get(key), [record.key]: record.value });
		},
		clear: async (tenantId, moduleId, key) => {
			const stored = values.get(keyOf(tenantId, moduleId));
			if (stored) delete stored[key];
		},
	};
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

/** One platform process composing automations.core, with its own run queue. */
function platformProcess(
	store: ModuleSettingsStore,
	databases: DatabaseProvider = shared.databases,
) {
	const settings = createModuleSettingsRuntime(store);
	settings.declare(OWNER_SETTINGS);
	const capabilities = createPlatformCapabilityRegistry();
	const keys: string[] = [];
	const queue: AgentRunQueue = {
		listAgents: async (tenantId) => [
			{
				id: tenantId + '-agent',
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
	capabilities.register(AGENT_RUN_QUEUE_CAPABILITY, queue);
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: {},
		settings,
		databases,
		dataClasses: { declare: () => {} },
		agentTools: { register: () => {} },
		agentDefinitions: { register: () => {} },
		capabilities,
	};
	const composition = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	return { composition, settings, capabilities, queue, keys };
}

function schedule(
	id: string,
	cadence: string,
	nextRunAt: number,
): StoredAutomationSchedule {
	return {
		id,
		tenantId: 'tenant-a',
		targetKind: 'agent',
		targetKey: 'tenant-a-agent',
		agentId: 'tenant-a-agent',
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
	};
}

const nextRunOf = async (id: string) =>
	(await shared.repository.getSchedule('tenant-a', id))?.nextRunAt;

/* A started worker runs its first pass at once. Waiting for what that pass
   leaves behind, rather than stopping straight away, keeps the drain out of
   what is being observed. */
const settled = (check: () => Promise<void> | void) =>
	vi.waitFor(check, { timeout: 5_000, interval: 10 });

describe('automations.core web and worker roles', () => {
	it('AUTO-WEB-WORKER-ROLE serves Run now and a webhook in web role and fires the due slot once in the worker', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at('2026-09-12T08:00:30.000Z'));
		const slot = at('2026-09-12T08:00:00.000Z');
		await shared.repository.createSchedule(
			schedule('hourly', 'every:60', slot),
		);
		const store = settingsStore();
		const web = platformProcess(store);
		const worker = platformProcess(store);
		try {
			/* The key the test environment seals trigger secrets with. */
			const created = await new AutomationTriggerService(
				shared.repository,
				new AesGcmSecretVault(Buffer.alloc(32, 0x41)),
				web.queue,
				Date.now,
			).create('tenant-a', 'owner-1', {
				agentId: 'tenant-a-agent',
				label: 'Signed trigger',
				enabled: true,
			});
			web.composition.start?.();
			await web.capabilities
				.get<AutomationExecutionCapability>(AUTOMATION_EXECUTION_CAPABILITY)!
				.runScheduleNow(
					{
						scheduleId: 'hourly',
						idempotencyKey: 'run-now-request-1',
						allowedTargetKinds: ['agent'],
					},
					{
						tenantId: 'tenant-a',
						actor: userActor({
							accountId: 'owner-1',
							displayName: 'Owner',
							email: 'owner@example.com',
						}),
						permissionSnapshot: [AUTOMATIONS_PERMISSIONS.manage],
					},
				);
			const timestamp = String(Date.now());
			const body = '{"order":"42"}';
			const request = new Request(
				`https://erp.example/api/automations/triggers/${created.trigger.id}/fire`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						[TRIGGER_TIMESTAMP_HEADER]: timestamp,
						[TRIGGER_SIGNATURE_HEADER]:
							'v1=' +
							triggerSignature(
								created.secret,
								triggerSignedPayload(timestamp, body),
							),
					},
					body,
				},
			);
			const fire = web.composition.routes!.find(
				(route) => route.path === '/api/automations/triggers/:id/fire',
			)!;
			const response = await fire.handler({
				request,
				params: { id: created.trigger.id },
				url: new URL(request.url),
				state: new Map(),
			} as never);
			expect(response.status).toBe(202);

			/* A stop drains any pass the web role had started; it started none, so
			   the due slot is still where it was and only the two requests ran. */
			await web.composition.stop?.();
			expect(web.keys).toHaveLength(2);
			expect(web.keys[0]).toBe('run-now-request-1');
			expect(web.keys.some((key) => key.startsWith('schedule:'))).toBe(false);
			expect(
				await shared.repository.getSchedule('tenant-a', 'hourly'),
			).toMatchObject({ nextRunAt: slot, lastRunAt: null });

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await settled(async () => {
				expect(worker.keys).toEqual([`schedule:hourly:${slot}`]);
				expect(await nextRunOf('hourly')).toBe(at('2026-09-12T09:00:00.000Z'));
			});
			await worker.composition.stop?.();
		} finally {
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});

	it('AUTO-WEB-WORKER-ROLE starts the scheduler again after a drained stop', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at('2026-09-12T08:00:30.000Z'));
		await shared.repository.createSchedule(
			schedule('hourly', 'every:60', at('2026-09-12T08:00:00.000Z')),
		);
		const worker = platformProcess(settingsStore());
		try {
			await worker.composition.startWorker?.();
			await settled(async () =>
				expect(await nextRunOf('hourly')).toBe(at('2026-09-12T09:00:00.000Z')),
			);
			await worker.composition.stop?.();
			vi.setSystemTime(at('2026-09-12T09:00:30.000Z'));
			await worker.composition.startWorker?.();
			await settled(async () =>
				expect(await nextRunOf('hourly')).toBe(at('2026-09-12T10:00:00.000Z')),
			);
			await worker.composition.stop?.();
			expect(worker.keys).toEqual([
				`schedule:hourly:${at('2026-09-12T08:00:00.000Z')}`,
				`schedule:hourly:${at('2026-09-12T09:00:00.000Z')}`,
			]);
			expect(
				(await shared.repository.getSchedule('tenant-a', 'hourly'))?.lastError,
			).toBeNull();
		} finally {
			await worker.composition.dispose?.();
		}
	});

	it('AUTO-WEB-WORKER-ROLE stops and disposes a composition whose worker never started', async () => {
		let acquired = 0;
		const databases: DatabaseProvider = {
			acquire: async () => {
				acquired += 1;
				throw new Error('No database in this case.');
			},
			dispose: async () => undefined,
		};
		const web = platformProcess(settingsStore(), databases);
		web.composition.start?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await web.composition.stop?.();
		await web.composition.dispose?.();
		expect(web.composition.startWorker).toBeTypeOf('function');
		expect(acquired).toBe(0);
	});
});

/* Refuses the first background lease, which an open takes after its runtime
   lease, and counts the releases of every runtime lease handed out. */
function refuseFirstOpen(databases: DatabaseProvider) {
	const acquire = databases.acquire.bind(databases);
	const runtimeReleases: ReturnType<typeof vi.fn>[] = [];
	let refused = 0;
	const spy = vi
		.spyOn(databases, 'acquire')
		.mockImplementation(async (request) => {
			if (request.purpose === 'background' && refused === 0) {
				refused += 1;
				throw new Error('background pool unavailable');
			}
			const lease = await acquire(request);
			if (request.purpose === 'migration' || request.purpose === 'background')
				return lease;
			const release = vi.fn(() => lease.release());
			runtimeReleases.push(release);
			return { database: lease.database, release };
		});
	return {
		runtimeReleases,
		refused: () => refused,
		restore: () => spy.mockRestore(),
	};
}

describe('an automations worker whose database open failed', () => {
	it('opens it again on the next startWorker of the same composition and released what the failed open held', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at('2026-09-12T08:00:30.000Z'));
		const slot = at('2026-09-12T08:00:00.000Z');
		await shared.repository.createSchedule(
			schedule('hourly', 'every:60', slot),
		);
		const worker = platformProcess(settingsStore());
		const refusal = refuseFirstOpen(shared.databases);
		try {
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(refusal.refused()).toBe(1);
			expect(refusal.runtimeReleases).toHaveLength(1);
			expect(refusal.runtimeReleases[0]).toHaveBeenCalledTimes(1);
			expect(await nextRunOf('hourly')).toBe(slot);

			await worker.composition.startWorker?.();
			await settled(async () =>
				expect(await nextRunOf('hourly')).toBe(at('2026-09-12T09:00:00.000Z')),
			);
			await worker.composition.stop?.();
			expect(worker.keys).toEqual([`schedule:hourly:${slot}`]);
		} finally {
			refusal.restore();
			await worker.composition.dispose?.();
		}
	});
});
