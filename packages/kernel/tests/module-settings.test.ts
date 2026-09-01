import { describe, expect, it, vi } from 'vitest';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingChange,
	type ModuleSettingRecord,
	type ModuleSettingsStore,
} from '../src/index.ts';

function memoryStore(): ModuleSettingsStore & {
	readonly rows: Map<string, ModuleSettingRecord>;
	loads: number;
} {
	const rows = new Map<string, ModuleSettingRecord>();
	const store = {
		rows,
		loads: 0,
		load(tenantId: string, moduleId: string) {
			store.loads += 1;
			const values: Record<string, ModuleSettingRecord['value']> = {};
			for (const row of rows.values()) {
				if (row.tenantId === tenantId && row.moduleId === moduleId) {
					values[row.key] = row.value;
				}
			}
			return values;
		},
		save(record: ModuleSettingRecord) {
			rows.set(`${record.tenantId}|${record.moduleId}|${record.key}`, record);
		},
		clear(tenantId: string, moduleId: string, key: string) {
			rows.delete(`${tenantId}|${moduleId}|${key}`);
		},
	};
	return store;
}

const declaration = defineModuleSettings({
	moduleId: 'agents.core',
	settings: {
		workerConcurrency: {
			type: 'number',
			defaultValue: 2,
			visibility: 'private',
			client: false,
			label: 'Worker concurrency',
			min: 1,
			max: 16,
		},
		defaultModel: {
			type: 'string',
			defaultValue: 'small',
			visibility: 'shared',
			client: true,
			enum: ['small', 'large'],
		},
		apiKey: {
			type: 'string',
			defaultValue: '',
			visibility: 'private',
			client: false,
			secret: true,
		},
		allowSignUp: {
			type: 'boolean',
			defaultValue: true,
			visibility: 'shared',
			client: true,
			scope: 'platform',
		},
	},
});

describe('module settings runtime', () => {
	it('resolves declared defaults until a tenant stores a value', () => {
		const store = memoryStore();
		const runtime = createModuleSettingsRuntime(store, { now: () => 5 });
		runtime.declare(declaration);
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
		runtime.set('tenant-a', 'agents.core', 'workerConcurrency', 8, 'owner');
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(8);
		expect(runtime.get('tenant-b', 'agents.core', 'workerConcurrency')).toBe(2);
		runtime.set('tenant-a', 'agents.core', 'workerConcurrency', null, 'owner');
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
	});

	it('validates type, bounds, and enum membership', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		expect(() =>
			runtime.set('tenant-a', 'agents.core', 'workerConcurrency', 32, 'owner'),
		).toThrow(/at most 16/);
		expect(() =>
			runtime.set('tenant-a', 'agents.core', 'workerConcurrency', 'x', 'owner'),
		).toThrow(/must be number/);
		expect(() =>
			runtime.set('tenant-a', 'agents.core', 'defaultModel', 'huge', 'owner'),
		).toThrow(/one of/);
		expect(() =>
			runtime.set('tenant-a', 'agents.core', 'missing', 1, 'owner'),
		).toThrow(/Unknown setting/);
		expect(() => runtime.get('tenant-a', 'other.core', 'key')).toThrow(
			/declares no settings/,
		);
	});

	it('shares platform-scoped values and keeps secrets out of listings', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		runtime.set('tenant-a', 'agents.core', 'allowSignUp', false, 'owner');
		expect(runtime.get('tenant-b', 'agents.core', 'allowSignUp')).toBe(false);
		expect(
			runtime.get(PLATFORM_SETTINGS_TENANT, 'agents.core', 'allowSignUp'),
		).toBe(false);
		runtime.set('tenant-a', 'agents.core', 'apiKey', 'sk-live', 'owner');
		const entries = runtime.list('tenant-a');
		const secret = entries.find((entry) => entry.key === 'apiKey');
		expect(secret).toMatchObject({ value: null, hasValue: true });
		expect(JSON.stringify(entries)).not.toContain('sk-live');
		expect(runtime.get('tenant-a', 'agents.core', 'apiKey')).toBe('sk-live');
	});

	it('caches loads per tenant and module and invalidates on write', () => {
		const store = memoryStore();
		const runtime = createModuleSettingsRuntime(store);
		runtime.declare(declaration);
		runtime.get('tenant-a', 'agents.core', 'workerConcurrency');
		runtime.get('tenant-a', 'agents.core', 'defaultModel');
		expect(store.loads).toBe(1);
		runtime.set('tenant-a', 'agents.core', 'defaultModel', 'large', 'owner');
		expect(runtime.get('tenant-a', 'agents.core', 'defaultModel')).toBe(
			'large',
		);
		expect(store.loads).toBe(2);
	});

	it('notifies listeners and isolates a throwing one', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		runtime.onChange(() => {
			throw new Error('boom');
		});
		const stop = runtime.onChange((change) => seen.push(change));
		runtime.set('tenant-a', 'agents.core', 'defaultModel', 'large', 'owner');
		runtime.set('tenant-a', 'agents.core', 'defaultModel', null, 'owner');
		stop();
		runtime.set('tenant-a', 'agents.core', 'defaultModel', 'small', 'owner');
		expect(seen).toEqual([
			{
				tenantId: 'tenant-a',
				moduleId: 'agents.core',
				key: 'defaultModel',
				cleared: false,
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
			{
				tenantId: 'tenant-a',
				moduleId: 'agents.core',
				key: 'defaultModel',
				cleared: true,
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
		]);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it('rejects declarations whose defaults break their own rules', () => {
		expect(() =>
			defineModuleSettings({
				moduleId: 'broken.core',
				settings: {
					level: {
						type: 'string',
						defaultValue: 'x',
						visibility: 'private',
						client: false,
						enum: ['a', 'b'],
					},
				},
			}),
		).toThrow(/does not match/);
		expect(() =>
			defineModuleSettings({
				moduleId: 'broken.core',
				settings: {
					token: {
						type: 'string',
						defaultValue: '',
						visibility: 'shared',
						client: false,
						secret: true,
					},
				},
			}),
		).toThrow(/cannot be shared/);
	});
});
