import { describe, expect, it, vi } from 'vitest';
import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import type { PlatformServerContext } from '@flowdular/module-auth/server';

/* The runtime this composition builds. Only the re-timing call is observed, so
   the case needs no database: the real runtime opens one on its first request,
   and the schedules it would re-time belong to its own suite. */
const stub = vi.hoisted(() => ({ retimed: [] as string[] }));

vi.mock('../src/server/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/server/index.ts')>()),
	createAutomationsRuntime: () => ({
		scheduleService: () => Promise.reject(new Error('No database here.')),
		triggerService: () => Promise.reject(new Error('No database here.')),
		listAuditEvents: () => Promise.resolve([]),
		verifyAudit: () => Promise.reject(new Error('No database here.')),
		repository: () => Promise.reject(new Error('No database here.')),
		retimeSchedules: (tenantId: string) => {
			stub.retimed.push(tenantId);
		},
		start: () => {},
		stop: () => {},
		quiesce: () => Promise.resolve(),
		dispose: () => Promise.resolve(),
	}),
}));

const { createServerComposition } = await import('../src/platform.ts');

function memoryStore(): ModuleSettingsStore {
	const values = new Map<string, Record<string, ModuleSettingValue>>();
	const keyOf = (tenantId: string, moduleId: string) =>
		`${tenantId} ${moduleId}`;
	return {
		load: (tenantId, moduleId) => values.get(keyOf(tenantId, moduleId)) ?? {},
		save: (record) => {
			const key = keyOf(record.tenantId, record.moduleId);
			values.set(key, { ...values.get(key), [record.key]: record.value });
		},
		clear: (tenantId, moduleId, key) => {
			const stored = values.get(keyOf(tenantId, moduleId));
			if (stored) delete stored[key];
		},
	};
}

/* What system.core declares, and one neighbouring setting of this module, so a
   write that is not the workspace zone can be told apart from one that is. */
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
		locale: {
			type: 'string',
			defaultValue: 'en',
			visibility: 'shared',
			client: false,
			scope: 'tenant',
		},
	},
});

function platform() {
	const settings = createModuleSettingsRuntime(memoryStore());
	settings.declare(OWNER_SETTINGS);
	const services = new Map<string, unknown>();
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: {},
		settings,
		databases: {
			acquire: () => Promise.reject(new Error('No database in this case.')),
			dispose: () => Promise.resolve(),
		},
		dataClasses: { declare: () => {} },
		agentTools: { register: () => {} },
		agentDefinitions: { register: () => {} },
		capabilities: {
			register: (id: string, service: unknown) => {
				services.set(id, service);
			},
			get: (id: string) => services.get(id) ?? null,
			has: (id: string) => services.has(id),
		},
	};
	return { context: context as unknown as PlatformServerContext, settings };
}

describe('automations.core composition', () => {
	/* The workspace zone is the signal for when a cron slot lands, so the module
	   that schedules on it re-times that workspace the moment the zone changes,
	   and leaves every other workspace where it is. */
	it('re-times the schedules of the workspace whose zone changed', async () => {
		stub.retimed.length = 0;
		const { context, settings } = platform();
		const composition = createServerComposition(context);

		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_SETTING.moduleId,
			TENANT_TIME_ZONE_SETTING.key,
			'Europe/Warsaw',
			'owner',
		);
		expect(stub.retimed).toEqual(['tenant-a']);

		settings.set(
			'tenant-b',
			TENANT_TIME_ZONE_SETTING.moduleId,
			TENANT_TIME_ZONE_SETTING.key,
			'Asia/Tokyo',
			'owner',
		);
		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_SETTING.moduleId,
			TENANT_TIME_ZONE_SETTING.key,
			null,
			'owner',
		);
		expect(stub.retimed).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);

		/* A neighbouring setting of the same module is not the zone. */
		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_SETTING.moduleId,
			'locale',
			'pl',
			'owner',
		);
		expect(stub.retimed).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);

		/* Disposal detaches the listener, so a settings write after it re-times
		   nothing through a runtime that is gone. */
		await composition.dispose?.();
		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_SETTING.moduleId,
			TENANT_TIME_ZONE_SETTING.key,
			'Europe/Warsaw',
			'owner',
		);
		expect(stub.retimed).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);
	});
});
