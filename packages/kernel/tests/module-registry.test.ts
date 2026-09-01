import { describe, expect, it } from 'vitest';
import type { RegisteredModule } from '@coreloom/contracts';
import { createModuleRegistry, RegistryError } from '../src/index.ts';

function moduleOf(id: string, dependencies: string[] = []): RegisteredModule {
	return {
		manifest: {
			schemaVersion: 1,
			id,
			package: `@coreloom/module-${id.replace('.', '-')}`,
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
