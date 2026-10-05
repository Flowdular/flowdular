import { describe, expect, it, vi } from 'vitest';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	MODULE_SETTINGS_STALENESS_MS,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingChange,
	type ModuleSettingChangesPage,
	type ModuleSettingChangesRequest,
	type ModuleSettingDefinition,
	type ModuleSettingLogEntry,
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
		async load(tenantId: string, moduleId: string) {
			store.loads += 1;
			const values: Record<string, ModuleSettingRecord['value']> = {};
			for (const row of rows.values()) {
				if (row.tenantId === tenantId && row.moduleId === moduleId) {
					values[row.key] = row.value;
				}
			}
			return values;
		},
		async save(record: ModuleSettingRecord) {
			rows.set(`${record.tenantId}|${record.moduleId}|${record.key}`, record);
		},
		async clear(tenantId: string, moduleId: string, key: string) {
			rows.delete(`${tenantId}|${moduleId}|${key}`);
		},
	};
	return store;
}

/** A store whose every answer lands a tick later, as a database's would. */
function slowStore(): ModuleSettingsStore & { loads: number } {
	const memory = memoryStore();
	const later = <T>(value: () => Promise<T>): Promise<T> =>
		new Promise((resolve) => setTimeout(() => resolve(value()), 0));
	const store = {
		loads: 0,
		load(tenantId: string, moduleId: string) {
			store.loads += 1;
			return later(() => memory.load(tenantId, moduleId));
		},
		save: (record: ModuleSettingRecord) => later(() => memory.save(record)),
		clear: (tenantId: string, moduleId: string, key: string) =>
			later(() => memory.clear(tenantId, moduleId, key)),
	};
	return store;
}

/**
 * One store shared by several processes, keeping a change log the way a
 * database store does: every write appends a revision, and a read after a
 * cursor answers the changes past it.
 */
function logStore() {
	const memory = memoryStore();
	const entries: ModuleSettingLogEntry[] = [];
	const reads = { loads: [] as string[], logReads: 0 };
	const faults = { failLogRead: false, expire: false };
	let revision = 0;
	const append = (
		tenantId: string,
		moduleId: string,
		key: string,
		cleared: boolean,
	) => {
		revision += 1;
		entries.push({
			revision,
			tenantId,
			moduleId,
			key,
			cleared,
			changedAt: revision,
		});
		return { revision };
	};
	const store: ModuleSettingsStore = {
		async load(tenantId, moduleId) {
			reads.loads.push(`${tenantId}|${moduleId}`);
			return memory.load(tenantId, moduleId);
		},
		async save(record) {
			await memory.save(record);
			return append(record.tenantId, record.moduleId, record.key, false);
		},
		async clear(tenantId, moduleId, key) {
			await memory.clear(tenantId, moduleId, key);
			return append(tenantId, moduleId, key, true);
		},
		async newestRevision() {
			return { revision, cursor: String(revision) };
		},
		async changesAfter(
			request: ModuleSettingChangesRequest,
		): Promise<ModuleSettingChangesPage> {
			reads.logReads += 1;
			if (faults.failLogRead) throw new Error('log unavailable');
			if (faults.expire && request.after !== null) return { expired: true };
			const after = request.after === null ? 0 : Number(request.after);
			const rows = entries.filter(
				(entry) =>
					entry.revision > after &&
					(request.moduleId === undefined ||
						entry.moduleId === request.moduleId) &&
					(request.key === undefined || entry.key === request.key),
			);
			const page = rows.slice(0, request.limit);
			return {
				expired: false,
				changes: page,
				cursor: String(page.at(-1)?.revision ?? after),
				more: rows.length > page.length,
			};
		},
	};
	return { store, reads, faults };
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
	it('resolves declared defaults until a tenant stores a value', async () => {
		const store = memoryStore();
		const runtime = createModuleSettingsRuntime(store, { now: () => 5 });
		runtime.declare(declaration);
		await runtime.prime('tenant-a');
		await runtime.prime('tenant-b');
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
		await runtime.set(
			'tenant-a',
			'agents.core',
			'workerConcurrency',
			8,
			'owner',
		);
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(8);
		expect(runtime.get('tenant-b', 'agents.core', 'workerConcurrency')).toBe(2);
		await runtime.set(
			'tenant-a',
			'agents.core',
			'workerConcurrency',
			null,
			'owner',
		);
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
	});

	it('validates type, bounds, and enum membership', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		await expect(
			runtime.set('tenant-a', 'agents.core', 'workerConcurrency', 32, 'owner'),
		).rejects.toThrow(/at most 16/);
		await expect(
			runtime.set('tenant-a', 'agents.core', 'workerConcurrency', 'x', 'owner'),
		).rejects.toThrow(/must be number/);
		await expect(
			runtime.set('tenant-a', 'agents.core', 'defaultModel', 'huge', 'owner'),
		).rejects.toThrow(/one of/);
		await expect(
			runtime.set('tenant-a', 'agents.core', 'missing', 1, 'owner'),
		).rejects.toThrow(/Unknown setting/);
		expect(() => runtime.get('tenant-a', 'other.core', 'key')).toThrow(
			/declares no settings/,
		);
	});

	it('shares platform-scoped values and keeps secrets out of listings', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		await runtime.prime('tenant-a');
		await runtime.prime('tenant-b');
		await runtime.set('tenant-a', 'agents.core', 'allowSignUp', false, 'owner');
		expect(runtime.get('tenant-b', 'agents.core', 'allowSignUp')).toBe(false);
		expect(
			runtime.get(PLATFORM_SETTINGS_TENANT, 'agents.core', 'allowSignUp'),
		).toBe(false);
		await runtime.set('tenant-a', 'agents.core', 'apiKey', 'sk-live', 'owner');
		const entries = runtime.list('tenant-a');
		const secret = entries.find((entry) => entry.key === 'apiKey');
		expect(secret).toMatchObject({ value: null, hasValue: true });
		expect(JSON.stringify(entries)).not.toContain('sk-live');
		expect(runtime.get('tenant-a', 'agents.core', 'apiKey')).toBe('sk-live');
	});

	it('loads a tenant once per module and refreshes it on write', async () => {
		const store = memoryStore();
		const runtime = createModuleSettingsRuntime(store);
		runtime.declare(declaration);
		await runtime.prime('tenant-a');
		await runtime.prime('tenant-a');
		runtime.get('tenant-a', 'agents.core', 'workerConcurrency');
		runtime.get('tenant-a', 'agents.core', 'defaultModel');
		/* One tenant-scoped load and one platform-scoped load. */
		expect(store.loads).toBe(2);
		await runtime.set(
			'tenant-a',
			'agents.core',
			'defaultModel',
			'large',
			'owner',
		);
		expect(runtime.get('tenant-a', 'agents.core', 'defaultModel')).toBe(
			'large',
		);
		expect(store.loads).toBe(3);
	});

	/* The store may sit behind a database: a read answers only from a snapshot
	   the caller primed, and never a default in place of a value still in
	   flight. */
	it('serves a slow store after prime and refuses a read before it', async () => {
		const store = slowStore();
		await store.save({
			tenantId: 'tenant-a',
			moduleId: 'agents.core',
			key: 'workerConcurrency',
			value: 8,
			updatedBy: 'owner',
			updatedAt: 1,
		});
		const runtime = createModuleSettingsRuntime(store);
		runtime.declare(declaration);

		expect(() =>
			runtime.get('tenant-a', 'agents.core', 'workerConcurrency'),
		).toThrow(
			expect.objectContaining({ code: 'SETTINGS_NOT_PRIMED', status: 500 }),
		);
		expect(() => runtime.list('tenant-a')).toThrow(/prime/);

		const priming = runtime.prime('tenant-a');
		expect(() =>
			runtime.get('tenant-a', 'agents.core', 'workerConcurrency'),
		).toThrow(/not loaded/);
		await Promise.all([priming, runtime.prime('tenant-a')]);
		expect(store.loads).toBe(2);
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(8);
		expect(runtime.get('tenant-a', 'agents.core', 'allowSignUp')).toBe(true);
		expect(() =>
			runtime.get('tenant-b', 'agents.core', 'workerConcurrency'),
		).toThrow(/tenant tenant-b/);

		await runtime.set(
			'tenant-a',
			'agents.core',
			'workerConcurrency',
			3,
			'owner',
		);
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(3);
	});

	it('retries a prime whose load failed', async () => {
		const memory = memoryStore();
		let failures = 1;
		const store: ModuleSettingsStore = {
			...memory,
			load: (tenantId, moduleId) =>
				failures-- > 0
					? Promise.reject(new Error('database unavailable'))
					: memory.load(tenantId, moduleId),
		};
		const runtime = createModuleSettingsRuntime(store);
		runtime.declare(declaration);
		await expect(runtime.prime('tenant-a')).rejects.toThrow(
			'database unavailable',
		);
		await runtime.prime('tenant-a');
		expect(runtime.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
	});

	it('primes a module declared after the tenant was primed', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		await runtime.prime('tenant-a');
		runtime.declare(
			defineModuleSettings({
				moduleId: 'later.core',
				settings: {
					limit: {
						type: 'number',
						defaultValue: 1,
						visibility: 'private',
						client: false,
					},
				},
			}),
		);
		expect(() => runtime.get('tenant-a', 'later.core', 'limit')).toThrow(
			/not loaded/,
		);
		await runtime.prime('tenant-a');
		expect(runtime.get('tenant-a', 'later.core', 'limit')).toBe(1);
	});

	/* A pattern is one regular expression per declared setting, built where the
	   declaration is checked. Reads sit on the request path, so none of them may
	   build it again. */
	it('compiles a declared pattern once, not on every read', async () => {
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
		await runtime.set(
			'tenant-a',
			'patterned.core',
			'zone',
			'Europe/Warsaw',
			'owner',
		);

		const values: string[] = [];
		const built = countRegExps(() => {
			for (let index = 0; index < 50; index += 1) {
				values.push(runtime.get<string>('tenant-a', 'patterned.core', 'zone'));
			}
		});

		expect(built).toBe(0);
		expect([...new Set(values)]).toEqual(['Europe/Warsaw']);
	});

	it('notifies listeners and isolates a throwing one', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		runtime.onChange(() => {
			throw new Error('boom');
		});
		const stop = runtime.onChange((change) => seen.push(change));
		await runtime.set(
			'tenant-a',
			'agents.core',
			'defaultModel',
			'large',
			'owner',
		);
		await runtime.set('tenant-a', 'agents.core', 'defaultModel', null, 'owner');
		stop();
		await runtime.set(
			'tenant-a',
			'agents.core',
			'defaultModel',
			'small',
			'owner',
		);
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

	it('keeps a secret value out of the change a listener sees', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		runtime.onChange((change) => seen.push(change));
		await runtime.set('tenant-a', 'agents.core', 'apiKey', 'sk-live', 'owner');
		expect(seen[0]).toMatchObject({ previous: null, next: null });
		expect(JSON.stringify(seen)).not.toContain('sk-live');
	});

	it('reports a flag override and its reset with both values', async () => {
		const runtime = createModuleSettingsRuntime(memoryStore());
		runtime.declare(declaration);
		const seen: ModuleSettingChange[] = [];
		runtime.onChange((change) => seen.push(change));
		await runtime.prime('tenant-a');
		await runtime.prime('tenant-b');
		expect(runtime.get('tenant-a', 'agents.core', 'streamingRuns')).toBe(false);

		await runtime.set(
			'tenant-a',
			'agents.core',
			'streamingRuns',
			true,
			'owner',
		);
		expect(runtime.get('tenant-a', 'agents.core', 'streamingRuns')).toBe(true);
		/* A tenant override is that tenant's alone; the next workspace still
		   reads the declared default. */
		expect(runtime.get('tenant-b', 'agents.core', 'streamingRuns')).toBe(false);

		await runtime.set(
			'tenant-a',
			'agents.core',
			'streamingRuns',
			null,
			'owner',
		);
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

const otherDeclaration = defineModuleSettings({
	moduleId: 'other.core',
	settings: {
		pageSize: {
			type: 'number',
			defaultValue: 20,
			visibility: 'private',
			client: false,
		},
	},
});

/** One process over the shared store, on a clock the case moves by hand. */
function process(
	store: ModuleSettingsStore,
	clock: { now: number },
	declarations: readonly ModuleSettingsDeclaration[] = [
		declaration,
		otherDeclaration,
	],
) {
	const runtime = createModuleSettingsRuntime(store, { now: () => clock.now });
	for (const entry of declarations) runtime.declare(entry);
	return runtime;
}

describe('module settings runtime over a change log', () => {
	it('serves another process change within the bound and reloads only the pairs it names', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(shared.store, clock);
		await a.prime('tenant-a');
		await b.prime('tenant-a');
		await b.prime('tenant-b');

		await a.set('tenant-a', 'agents.core', 'workerConcurrency', 8, 'owner');
		await a.set('tenant-a', 'agents.core', 'allowSignUp', false, 'owner');
		await a.set('tenant-c', 'other.core', 'pageSize', 30, 'owner');
		expect(a.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(8);
		expect(a.get('tenant-a', 'agents.core', 'allowSignUp')).toBe(false);

		clock.now = MODULE_SETTINGS_STALENESS_MS;
		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(2);
		expect(b.get('tenant-a', 'agents.core', 'allowSignUp')).toBe(true);

		shared.reads.loads.length = 0;
		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(8);
		expect(b.get('tenant-b', 'agents.core', 'allowSignUp')).toBe(false);
		expect(b.get('tenant-b', 'agents.core', 'workerConcurrency')).toBe(2);
		expect([...shared.reads.loads].sort()).toEqual([
			'tenant-a|agents.core',
			'|agents.core',
		]);
	});

	it('reflects a named revision at once and announces a change only where it was saved', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(shared.store, clock);
		const seenA: ModuleSettingChange[] = [];
		const seenB: ModuleSettingChange[] = [];
		a.onChange((change) => seenA.push(change));
		b.onChange((change) => seenB.push(change));
		await a.prime('tenant-a');
		await b.prime('tenant-a');

		await a.set('tenant-a', 'agents.core', 'defaultModel', 'large', 'owner');
		const revision = seenA[0]?.revision;
		if (revision === undefined)
			throw new Error('The save carried no revision.');

		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'agents.core', 'defaultModel')).toBe('small');
		await b.prime('tenant-a', { revision });
		expect(b.get('tenant-a', 'agents.core', 'defaultModel')).toBe('large');

		clock.now += MODULE_SETTINGS_STALENESS_MS + 1;
		await b.prime('tenant-a');
		expect(seenA).toHaveLength(1);
		expect(seenB).toEqual([]);
	});

	it('fails a prime whose revalidation fails and serves the change once the log answers', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(shared.store, clock);
		await b.prime('tenant-a');
		await a.set('tenant-a', 'agents.core', 'workerConcurrency', 6, 'owner');

		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		shared.faults.failLogRead = true;
		await expect(b.prime('tenant-a')).rejects.toThrow('log unavailable');
		await expect(b.prime('tenant-a')).rejects.toThrow('log unavailable');

		shared.faults.failLogRead = false;
		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(6);
	});

	it('shares one log read between concurrent primes', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const b = process(shared.store, clock);
		await Promise.all([b.prime('tenant-a'), b.prime('tenant-b')]);
		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		const before = shared.reads.logReads;
		await Promise.all(
			['tenant-a', 'tenant-b', 'tenant-c', 'tenant-a'].map((tenantId) =>
				b.prime(tenantId),
			),
		);
		expect(shared.reads.logReads - before).toBe(1);
	});

	it('reloads everything it holds after more than a page of changes or an expired cursor', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(shared.store, clock);
		await b.prime('tenant-a');
		await b.prime('tenant-b');
		for (let value = 1; value <= 16; value += 1) {
			for (const tenantId of ['tenant-c', 'tenant-d']) {
				for (let round = 0; round < 16; round += 1) {
					await a.set(
						tenantId,
						'agents.core',
						'workerConcurrency',
						value,
						'owner',
					);
				}
			}
		}
		await a.set('tenant-b', 'other.core', 'pageSize', 50, 'owner');

		shared.reads.loads.length = 0;
		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		await b.prime('tenant-a');
		expect(b.get('tenant-b', 'other.core', 'pageSize')).toBe(50);
		expect([...shared.reads.loads].sort()).toEqual([
			'tenant-a|agents.core',
			'tenant-a|other.core',
			'tenant-b|agents.core',
			'tenant-b|other.core',
			'|agents.core',
		]);

		await a.set('tenant-a', 'other.core', 'pageSize', 70, 'owner');
		shared.faults.expire = true;
		shared.reads.loads.length = 0;
		clock.now = 2 * (MODULE_SETTINGS_STALENESS_MS + 1);
		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'other.core', 'pageSize')).toBe(70);
		expect(shared.reads.loads).toHaveLength(5);
	});

	it('reloads every held pair after an expired cursor without loading them all at once', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		let inFlight = 0;
		let peak = 0;
		const store: ModuleSettingsStore = {
			...shared.store,
			async load(tenantId, moduleId) {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					await new Promise((resolve) => setTimeout(resolve, 0));
					return await shared.store.load(tenantId, moduleId);
				} finally {
					inFlight -= 1;
				}
			},
		};
		const worker = process(store, clock);
		const tenants = Array.from({ length: 40 }, (_, index) => `tenant-${index}`);
		for (const tenantId of tenants) await worker.prime(tenantId);
		const held = new Set(shared.reads.loads);
		await process(shared.store, clock).set(
			'tenant-7',
			'other.core',
			'pageSize',
			70,
			'owner',
		);

		shared.faults.expire = true;
		shared.reads.loads.length = 0;
		peak = 0;
		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		await worker.prime('tenant-0');
		expect(worker.get('tenant-7', 'other.core', 'pageSize')).toBe(70);
		expect(new Set(shared.reads.loads)).toEqual(held);
		expect(peak).toBeLessThan(tenants.length);
	});

	it('reads again a pair it loaded before its first prime', async () => {
		const shared = logStore();
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(shared.store, clock);
		await b.set('tenant-a', 'agents.core', 'defaultModel', 'large', 'owner');
		await a.set('tenant-a', 'agents.core', 'defaultModel', 'small', 'owner');

		await b.prime('tenant-a');
		expect(b.get('tenant-a', 'agents.core', 'defaultModel')).toBe('small');
	});

	it('never lets a load begun before a write replace what the write left', async () => {
		const shared = logStore();
		const gated = { held: false, releases: [] as (() => void)[] };
		const store: ModuleSettingsStore = {
			...shared.store,
			async load(tenantId, moduleId) {
				const values = await shared.store.load(tenantId, moduleId);
				if (!gated.held) return values;
				return new Promise((resolve) =>
					gated.releases.push(() => resolve(values)),
				);
			},
		};
		const clock = { now: 0 };
		const a = process(shared.store, clock);
		const b = process(store, clock);
		await b.prime('tenant-a');
		await a.set('tenant-a', 'agents.core', 'workerConcurrency', 4, 'owner');

		clock.now = MODULE_SETTINGS_STALENESS_MS + 1;
		gated.held = true;
		const revalidating = b.prime('tenant-a');
		await vi.waitFor(() => expect(gated.releases).toHaveLength(1));
		gated.held = false;
		await b.set('tenant-a', 'agents.core', 'workerConcurrency', 9, 'owner');
		expect(b.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(9);

		gated.releases[0]!();
		await revalidating;
		expect(b.get('tenant-a', 'agents.core', 'workerConcurrency')).toBe(9);
	});

	it('reads the log through the runtime and refuses a page out of bounds', async () => {
		const shared = logStore();
		const runtime = process(shared.store, { now: 0 });
		await runtime.set('tenant-a', 'agents.core', 'defaultModel', 'large', 'o');
		await runtime.set('tenant-a', 'other.core', 'pageSize', 40, 'o');
		const page = await runtime.changesAfter({
			after: null,
			limit: 10,
			moduleId: 'other.core',
			key: 'pageSize',
		});
		expect(page).toMatchObject({
			expired: false,
			more: false,
			changes: [
				{
					tenantId: 'tenant-a',
					moduleId: 'other.core',
					key: 'pageSize',
					cleared: false,
				},
			],
		});

		for (const request of [
			{ after: null, limit: 0 },
			{ after: null, limit: 501 },
			{ after: null, limit: 1.5 },
			{ after: null, limit: 10, key: 'pageSize' },
		]) {
			await expect(runtime.changesAfter(request)).rejects.toMatchObject({
				code: 'INVALID_SETTINGS_PAGE',
			});
		}
		await expect(
			runtime.prime('tenant-a', { revision: -1 }),
		).rejects.toMatchObject({ code: 'INVALID_SETTINGS_REVISION' });
		await expect(
			createModuleSettingsRuntime(memoryStore()).changesAfter({
				after: null,
				limit: 10,
			}),
		).rejects.toMatchObject({ code: 'SETTINGS_LOG_UNAVAILABLE', status: 503 });
	});
});
