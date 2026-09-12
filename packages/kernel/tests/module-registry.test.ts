import { describe, expect, it } from 'vitest';
import type { RegisteredModule } from '@flowdular/contracts';
import { createModuleRegistry, RegistryError } from '../src/index.ts';

function moduleOf(id: string, dependencies: string[] = []): RegisteredModule {
	return {
		manifest: {
			schemaVersion: 1,
			id,
			package: `@flowdular/module-${id.replace('.', '-')}`,
			version: '0.1.0',
			profile: 'full',
			capabilities: ['client'],
			dependencies: dependencies.map((dependency) => ({
				id: dependency,
				range: '^0.1.0',
			})),
			tenancy: 'required',
			locales: ['en'],
			stability: 'experimental',
		},
	};
}

describe('createModuleRegistry', () => {
	it('orders dependencies before consumers', () => {
		const registry = createModuleRegistry([
			moduleOf('sales.orders', ['system.core']),
			moduleOf('system.core'),
		]);
		expect(registry.modules.map((module) => module.manifest.id)).toEqual([
			'system.core',
			'sales.orders',
		]);
	});

	it('rejects a missing dependency', () => {
		expect(() =>
			createModuleRegistry([moduleOf('sales.orders', ['system.core'])]),
		).toThrowError(RegistryError);
	});

	it('defaults permission-bound navigation to hidden', () => {
		const secured = {
			...moduleOf('system.core'),
			navigation: [
				{
					id: 'system.admin',
					label: 'Admin',
					href: '/admin',
					permission: 'system.admin.read',
				},
			],
		};
		const registry = createModuleRegistry([secured]);
		expect(registry.navigation()).toEqual([]);
		expect(registry.navigation(new Set(['system.admin.read']))).toHaveLength(1);
	});
});

it('rejects a declared dependency range that excludes the installed version', () => {
	const consumer = moduleOf('profile.core', ['auth.core']);
	const auth = moduleOf('auth.core');
	const upgraded = {
		...auth,
		manifest: { ...auth.manifest, version: '0.10.0' },
	};
	expect(() => createModuleRegistry([consumer, upgraded])).toThrow(
		/profile.core requires auth.core \^0.1.0; available 0.10.0/,
	);
});
it('rejects invalid ranges and incompatible platform APIs', () => {
	const module = moduleOf('sample.core');
	expect(() =>
		createModuleRegistry([
			{ ...module, manifest: { ...module.manifest, platformApi: '^9.0.0' } },
		]),
	).toThrow(/platform API/);
	expect(() =>
		createModuleRegistry([
			{
				...module,
				manifest: {
					...module.manifest,
					dependencies: [{ id: 'auth.core', range: 'not-semver' }],
				},
			},
		]),
	).toThrow(/invalid range/);
});

describe('capability provides and requires', () => {
	function withCapabilities(
		module: RegisteredModule,
		provides: string[],
		requires: { id: string; optional?: boolean }[] = [],
	): RegisteredModule {
		return {
			...module,
			manifest: { ...module.manifest, provides, requires },
		};
	}

	it('orders a required capability provider before its consumer', () => {
		const registry = createModuleRegistry([
			withCapabilities(
				moduleOf('automations.core'),
				[],
				[{ id: 'agents.run-queue' }],
			),
			withCapabilities(moduleOf('agents.core'), ['agents.run-queue']),
		]);
		expect(registry.modules.map((module) => module.manifest.id)).toEqual([
			'agents.core',
			'automations.core',
		]);
	});

	it('rejects a required capability nobody provides and tolerates an optional one', () => {
		expect(() =>
			createModuleRegistry([
				withCapabilities(
					moduleOf('automations.core'),
					[],
					[{ id: 'agents.run-queue' }],
				),
			]),
		).toThrow(/requires capability "agents.run-queue"/);
		expect(() =>
			createModuleRegistry([
				withCapabilities(
					moduleOf('agents.core'),
					[],
					[{ id: 'notifications.publish.v1', optional: true }],
				),
			]),
		).not.toThrow();
	});

	it('rejects two providers of one capability', () => {
		expect(() =>
			createModuleRegistry([
				withCapabilities(moduleOf('agents.core'), ['agents.run-queue']),
				withCapabilities(moduleOf('other.core'), ['agents.run-queue']),
			]),
		).toThrow(/provided by both/);
	});

	it('lets an optional requirement close a cycle without ordering it', () => {
		const registry = createModuleRegistry([
			withCapabilities(
				moduleOf('agents.core'),
				['agents.run-queue'],
				[{ id: 'notifications.publish.v1', optional: true }],
			),
			withCapabilities(
				moduleOf('notifications.core'),
				['notifications.publish.v1'],
				[{ id: 'agents.run-queue' }],
			),
		]);
		expect(registry.modules.map((module) => module.manifest.id)).toEqual([
			'agents.core',
			'notifications.core',
		]);
	});
});
