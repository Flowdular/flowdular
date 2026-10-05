import { describe, expect, it, vi } from 'vitest';
import {
	createModuleSettingsRuntime,
	type ModuleSettingsRuntime,
	type ModuleSettingsStore,
} from '@flowdular/kernel';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import type { AutomationsRuntimeOptions } from '../src/server/runtime.ts';

/* The runtime this composition builds. Only what it is handed is observed, so
   the case needs no database. */
const stub = vi.hoisted(() => ({
	options: [] as unknown[],
}));

vi.mock('../src/server/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/server/index.ts')>()),
	createAutomationsRuntime: (options: unknown) => {
		stub.options.push(options);
		return {
			scheduleService: () => Promise.reject(new Error('No database here.')),
			triggerService: () => Promise.reject(new Error('No database here.')),
			listAuditEvents: () => Promise.resolve([]),
			verifyAudit: () => Promise.reject(new Error('No database here.')),
			repository: () => Promise.reject(new Error('No database here.')),
			start: () => {},
			stop: () => {},
			quiesce: () => Promise.resolve(),
			dispose: () => Promise.resolve(),
		};
	},
}));

const { createServerComposition } = await import('../src/platform.ts');

const emptyStore: ModuleSettingsStore = {
	load: async () => ({}),
	save: async () => undefined,
	clear: async () => undefined,
};

function platform(settings: ModuleSettingsRuntime) {
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
	return context as unknown as PlatformServerContext;
}

describe('automations.core composition', () => {
	/* A zone change reaches the scheduler through the settings change log, so
	   the composition hands its runtime the settings and listens to nothing. */
	it('AUTO-WORKER-TIME-ZONE hands the runtime the settings and subscribes to no settings change', async () => {
		stub.options.length = 0;
		const settings = createModuleSettingsRuntime(emptyStore);
		const subscribe = vi.spyOn(settings, 'onChange');
		const composition = createServerComposition(platform(settings));

		expect(subscribe).not.toHaveBeenCalled();
		expect(stub.options).toHaveLength(1);
		expect((stub.options[0] as AutomationsRuntimeOptions).settings).toBe(
			settings,
		);
		await composition.dispose?.();
	});
});
