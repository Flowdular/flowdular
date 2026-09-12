import { describe, expect, it, vi } from 'vitest';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingChange,
	type ModuleSettingDefinition,
	type ModuleSettingRecord,
	type ModuleSettingsDeclaration,
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

/** How many regular expressions the run built. */
function countRegExps(run: () => void): number {
	const real = globalThis.RegExp;
	let built = 0;
	globalThis.RegExp = new Proxy(real, {
		construct: (target, args, newTarget) => {
			built += 1;
			return Reflect.construct(target, args, newTarget) as object;
		},
	});
	try {
		run();
	} finally {
		globalThis.RegExp = real;
	}
	return built;
}

const declaration = defineModuleSettings({
	moduleId: 'agents.core',
	settings: {
		workerConcurrency: {
			type: 'number',
			defaultValue: 2,
			visibility: 'private',
			client: false,
			labelKey: 'agents.settings.workerConcurrency.label',
			label: 'Worker concurrency',
			descriptionKey: 'agents.settings.workerConcurrency.description',
			description: 'Maximum concurrent runs.',
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
		streamingRuns: {
			type: 'boolean',
			defaultValue: false,
			visibility: 'private',
			client: false,
			kind: 'flag',
			scope: 'tenant',
			label: 'Streaming runs',
			description: 'Streams run output to the screen while the run works.',
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

	/* A pattern is one regular expression per declared setting, built where the
	   declaration is checked. Reads sit on the request path, so none of them may
	   build it again. */
	it('compiles a declared pattern once, not on every read', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		const patterned = defineModuleSettings({
			moduleId: 'patterned.core',
			settings: {
				zone: {
					type: 'string',
					defaultValue: 'UTC',
					visibility: 'shared',
					client: false,
					pattern: '[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}',
				},
			},
		});
		runtime.declare(patterned);
		runtime.set('tenant-a', 'patterned.core', 'zone', 'Europe/Warsaw', 'owner');

		const values: string[] = [];
		const built = countRegExps(() => {
			for (let index = 0; index < 50; index += 1) {
				values.push(runtime.get<string>('tenant-a', 'patterned.core', 'zone'));
			}
		});

		expect(built).toBe(0);
		expect([...new Set(values)]).toEqual(['Europe/Warsaw']);
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
				previous: 'small',
				next: 'large',
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
			{
				tenantId: 'tenant-a',
				moduleId: 'agents.core',
				key: 'defaultModel',
				cleared: true,
				previous: 'large',
				next: 'small',
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
		]);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it('keeps a secret value out of the change a listener sees', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		runtime.onChange((change) => seen.push(change));
		runtime.set('tenant-a', 'agents.core', 'apiKey', 'sk-live', 'owner');
		expect(seen[0]).toMatchObject({ previous: null, next: null });
		expect(JSON.stringify(seen)).not.toContain('sk-live');
	});

	it('reports a flag override and its reset with both values', () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		runtime.onChange((change) => seen.push(change));
		expect(runtime.get('tenant-a', 'agents.core', 'streamingRuns')).toBe(false);

		runtime.set('tenant-a', 'agents.core', 'streamingRuns', true, 'owner');
		expect(runtime.get('tenant-a', 'agents.core', 'streamingRuns')).toBe(true);
		/* A tenant override is that tenant's alone; the next workspace still
		   reads the declared default. */
		expect(runtime.get('tenant-b', 'agents.core', 'streamingRuns')).toBe(false);

		runtime.set('tenant-a', 'agents.core', 'streamingRuns', null, 'owner');
		expect(runtime.get('tenant-a', 'agents.core', 'streamingRuns')).toBe(false);
		expect(seen).toEqual([
			{
				tenantId: 'tenant-a',
				moduleId: 'agents.core',
				key: 'streamingRuns',
				cleared: false,
				kind: 'flag',
				previous: false,
				next: true,
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
			{
				tenantId: 'tenant-a',
				moduleId: 'agents.core',
				key: 'streamingRuns',
				cleared: true,
				kind: 'flag',
				previous: true,
				next: false,
				actor: { accountId: 'owner', tenantId: 'tenant-a' },
			},
		]);
	});

	it('rejects a flag that is not a described, non-secret boolean', () => {
		const flag =
			(
				definition: ModuleSettingDefinition,
			): (() => ModuleSettingsDeclaration) =>
			() =>
				defineModuleSettings({
					moduleId: 'broken.core',
					settings: { fast: definition },
				});
		const described = {
			visibility: 'private',
			client: false,
			kind: 'flag',
			label: 'Fast path',
			description: 'Takes the fast path.',
		} as const;
		expect(flag({ ...described, type: 'string', defaultValue: 'off' })).toThrow(
			/non-secret boolean/,
		);
		expect(
			flag({
				type: 'boolean',
				defaultValue: false,
				kind: 'flag',
				label: 'Fast path',
				description: 'Takes the fast path.',
				visibility: 'private',
				client: false,
				secret: true,
			}),
		).toThrow(/non-secret boolean/);
		expect(
			flag({
				type: 'boolean',
				defaultValue: false,
				visibility: 'private',
				client: false,
				kind: 'flag',
				description: 'Takes the fast path.',
			}),
		).toThrow(/label and a description/);
		expect(
			flag({
				type: 'boolean',
				defaultValue: false,
				visibility: 'private',
				client: false,
				kind: 'flag',
				label: 'Fast path',
			}),
		).toThrow(/label and a description/);
		expect(
			flag({ ...described, type: 'boolean', defaultValue: false }),
		).not.toThrow();
		expect(
			flag({
				...described,
				type: 'boolean',
				defaultValue: false,
				scope: 'tenant',
			}),
		).not.toThrow();
	});

	/* A flag is on or off for a workspace, and the screen that turns it on is
	   the workspace's. A platform-scoped one would be a deployment-wide switch
	   an operator flips from inside one workspace for every other. */
	it('refuses a flag that is not scoped to a workspace', () => {
		expect(() =>
			defineModuleSettings({
				moduleId: 'broken.core',
				settings: {
					fast: {
						type: 'boolean',
						defaultValue: false,
						visibility: 'private',
						client: false,
						kind: 'flag',
						scope: 'platform',
						label: 'Fast path',
						description: 'Takes the fast path.',
					},
				},
			}),
		).toThrow(/tenant-scoped/);
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

	it('accepts namespaced translation keys and rejects invalid ownership', () => {
		expect(declaration.settings.workerConcurrency).toMatchObject({
			labelKey: 'agents.settings.workerConcurrency.label',
			descriptionKey: 'agents.settings.workerConcurrency.description',
		});
		expect(() =>
			defineModuleSettings({
				moduleId: 'agents.core',
				settings: {
					workerConcurrency: {
						type: 'number',
						defaultValue: 2,
						visibility: 'private',
						client: false,
						labelKey: 'auth.settings.workerConcurrency.label',
					},
				},
			}),
		).toThrow(/invalid labelKey/);
		expect(() =>
			defineModuleSettings({
				moduleId: 'agents.core',
				settings: {
					workerConcurrency: {
						type: 'number',
						defaultValue: 2,
						visibility: 'private',
						client: false,
						descriptionKey: 'agents invalid key',
					},
				},
			}),
		).toThrow(/invalid descriptionKey/);
	});
});
