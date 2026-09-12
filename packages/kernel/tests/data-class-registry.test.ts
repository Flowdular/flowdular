import { describe, expect, it } from 'vitest';
import { createDataClassRegistry, RegistryError } from '../src/index.ts';
import type { DataClassDeclaration } from '../src/index.ts';

function runs(
	overrides: Partial<Record<keyof DataClassDeclaration, unknown>> = {},
): DataClassDeclaration {
	const declaration: Record<string, unknown> = {
		key: 'runs',
		label: 'Agent runs',
		defaultRetentionDays: 90,
		exportable: true,
		sweep: async () => ({ removed: 0 }),
		export: async () => ({ rows: 0, from: null, to: null }),
		erase: async () => ({ removed: 0 }),
		count: async () => 0,
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete declaration[key];
		else declaration[key] = value;
	}
	return declaration as unknown as DataClassDeclaration;
}

describe('platform data class registry', () => {
	it('lists every module that declared, in composition order, including one holding nothing', () => {
		const registry = createDataClassRegistry();
		registry.declare('agents.core', [runs()]);
		registry.declare('notifications.core', []);
		registry.declare('workflows.core', [runs({ key: 'run-payloads' })]);

		expect(
			registry.list().map((entry) => ({
				moduleId: entry.moduleId,
				classes: entry.classes.map((declaration) => declaration.key),
			})),
		).toEqual([
			{ moduleId: 'agents.core', classes: ['runs'] },
			{ moduleId: 'notifications.core', classes: [] },
			{ moduleId: 'workflows.core', classes: ['run-payloads'] },
		]);
	});

	it('seals one immutable snapshot every reader shares', () => {
		const registry = createDataClassRegistry();
		registry.declare('agents.core', [runs()]);

		registry.seal();
		const first = registry.list();

		expect(first).toBe(registry.list());
		expect(Object.isFrozen(first)).toBe(true);
		registry.seal();
		expect(registry.list()).toBe(first);
	});

	it('refuses a declaration after the registry is sealed and keeps the catalogue', () => {
		const registry = createDataClassRegistry();
		registry.declare('agents.core', [runs()]);
		registry.seal();

		expect(() => registry.declare('users.core', [])).toThrow(
			/after the platform started/,
		);
		expect(registry.list().map((entry) => entry.moduleId)).toEqual([
			'agents.core',
		]);
	});

	it('refuses a second declaration from the same module', () => {
		const registry = createDataClassRegistry();
		registry.declare('agents.core', [runs()]);

		expect(() => registry.declare('agents.core', [])).toThrow(
			/declared its data classes twice/,
		);
	});

	it('refuses a class id another module already owns', () => {
		const registry = createDataClassRegistry();
		registry.declare('agents.core', [runs()]);
		/* Two modules cannot own one class id even when the keys differ per
		   module, because the sweep and the export resolve an owner by class id. */
		expect(() => registry.forModule('agents.core').declare([runs()])).toThrow();
		expect(registry.list()).toHaveLength(1);
	});

	it('refuses a duplicate key inside one batch and records none of the module', () => {
		const registry = createDataClassRegistry();

		expect(() => registry.declare('agents.core', [runs(), runs()])).toThrow(
			/already owns/,
		);
		expect(registry.list()).toEqual([]);
	});

	it('refuses an invalid declaration and records none of the module', () => {
		const registry = createDataClassRegistry();
		const cases: readonly [string, Record<string, unknown>][] = [
			['an upper case key', { key: 'Runs' }],
			['a zero default', { defaultRetentionDays: 0 }],
			['a blank label', { label: ' ' }],
			['no exclusion reason', { exportable: false }],
			['a sweep that is not a function', { sweep: 'now' }],
			['an export that is not a function', { export: 42 }],
		];
		for (const [, overrides] of cases) {
			expect(() =>
				registry.declare('agents.core', [runs(), runs(overrides)]),
			).toThrow(RegistryError);
			expect(registry.list()).toEqual([]);
		}
		expect(() => registry.declare('agents', [runs()])).toThrow(
			/is not a module id/,
		);
		expect(() =>
			registry.declare('agents.core', new Array(65).fill(runs())),
		).toThrow(/at most 64/);
		expect(registry.list()).toEqual([]);
	});

	/* Each case carries its own key, so the only refusal it can raise is the one
	   it is about: two declarations under one key would be refused as a duplicate
	   whatever their operations look like. */
	it('refuses an erase or a count that is not a function', () => {
		const registry = createDataClassRegistry();

		expect(() =>
			registry.declare('agents.core', [runs({ key: 'a', erase: 'now' })]),
		).toThrow(/declared an erase operation that is not a function/);
		expect(() =>
			registry.declare('agents.core', [runs({ key: 'b', count: 42 })]),
		).toThrow(/declared a count operation that is not a function/);
		expect(registry.list()).toEqual([]);
	});

	it('accepts a class without a sweep, an export or an erase operation', () => {
		const registry = createDataClassRegistry();

		registry.declare('users.core', [
			runs({
				key: 'members',
				defaultRetentionDays: null,
				exportable: false,
				excludedReason: 'Business records are kept until a person deletes.',
				sweep: undefined,
				export: undefined,
				erase: undefined,
				count: undefined,
			}),
		]);

		const [declaration] = registry.list()[0]!.classes;
		expect({
			sweep: declaration!.sweep,
			export: declaration!.export,
			erase: declaration!.erase,
			count: declaration!.count,
			defaultRetentionDays: declaration!.defaultRetentionDays,
		}).toEqual({
			sweep: undefined,
			export: undefined,
			erase: undefined,
			count: undefined,
			defaultRetentionDays: null,
		});
	});

	/* Erasure resolves the owner through the sealed catalogue, so the operations
	   a module declared have to survive sealing by identity: a reader calls the
	   very function the owner registered, not a copy of its shape. */
	it('carries the erase and count operations of a class through the seal', async () => {
		const registry = createDataClassRegistry();
		const erased: { tenantId: string; accountId: string; limit: number }[] = [];
		const erase = async (input: {
			tenantId: string;
			subject: { accountId: string };
			limit: number;
		}) => {
			erased.push({
				tenantId: input.tenantId,
				accountId: input.subject.accountId,
				limit: input.limit,
			});
			return { removed: 2, truncated: true };
		};
		registry.declare('agents.core', [
			runs({ erase, count: async () => 7 }),
			runs({ key: 'traces', erase: undefined, count: undefined }),
		]);

		registry.seal();

		const [withErase, withoutErase] = registry.list()[0]!.classes;
		expect(withErase!.erase).toBe(erase);
		expect(withoutErase!.erase).toBeUndefined();
		expect(
			await withErase!.erase!({
				tenantId: 'tenant-alpha',
				subject: { accountId: 'account-bob' },
				limit: 500,
			}),
		).toEqual({ removed: 2, truncated: true });
		expect(erased).toEqual([
			{ tenantId: 'tenant-alpha', accountId: 'account-bob', limit: 500 },
		]);
		expect(
			await withErase!.count!({
				tenantId: 'tenant-alpha',
				subject: { accountId: 'account-bob' },
			}),
		).toBe(7);
	});

	it('binds declaration ownership to the composing module', () => {
		const registry = createDataClassRegistry();
		const agents = registry.forModule('agents.core');

		agents.declare([runs()]);

		expect(() => agents.declare('users.core', [])).toThrow(
			/cannot declare data classes owned by users\.core/,
		);
		expect(() => agents.forModule('users.core')).toThrow(
			/cannot obtain the data class registrar/,
		);
		expect(agents.forModule('agents.core')).toBe(agents);
		expect(registry.list().map((entry) => entry.moduleId)).toEqual([
			'agents.core',
		]);
	});

	it('refuses the module form on the unbound platform registry', () => {
		const registry = createDataClassRegistry();

		expect(() => registry.declare([runs()])).toThrow(/needs a module id/);
		expect(registry.list()).toEqual([]);
	});

	it('answers the whole sealed catalogue through a bound view', () => {
		const registry = createDataClassRegistry();
		registry.forModule('agents.core').declare([runs()]);
		const audit = registry.forModule('audit.core');
		audit.declare([runs({ key: 'events' })]);

		registry.seal();

		expect(audit.list().map((entry) => entry.moduleId)).toEqual([
			'agents.core',
			'audit.core',
		]);
		expect(audit.list()).toBe(registry.list());
	});
});
