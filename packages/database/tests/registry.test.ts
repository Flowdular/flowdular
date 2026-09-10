import { describe, expect, it, vi } from 'vitest';
import {
	createDatabaseAdapterRegistry,
	DATABASE_CAPABILITY_IDS,
	validateDatabaseSelection,
	type DatabaseAdapterDescriptor,
} from '../src/index.ts';

function descriptor(
	override: Partial<DatabaseAdapterDescriptor> = {},
): DatabaseAdapterDescriptor {
	return {
		adapterId: 'vendor.distributed-sql',
		dialectId: 'postgresql',
		label: 'Distributed SQL',
		description: 'A registered PostgreSQL-compatible adapter.',
		capabilities: {
			features: [
				DATABASE_CAPABILITY_IDS.TRANSACTIONS,
				DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
			],
			isolationLevels: ['read-committed', 'serializable'],
		},
		configurationSchema: {
			version: 1,
			fields: [
				{
					key: 'region',
					label: 'Region',
					description: 'Database region.',
					kind: 'text',
					required: true,
					secret: false,
				},
				{
					key: 'connection-url',
					label: 'Connection URL',
					description: 'Stored outside the safe platform configuration.',
					kind: 'text',
					required: true,
					secret: true,
				},
			],
		},
		validate: () => [],
		probe: async () => ({ status: 'ready', latencyMs: 1 }),
		provision: async () => {},
		connect: async () => {
			throw new Error('not used');
		},
		...override,
	};
}

describe('database adapter registry', () => {
	it('registers an open adapter id and exposes metadata without operations', () => {
		const registry = createDatabaseAdapterRegistry();
		const connect = vi.fn(descriptor().connect);
		registry.register(descriptor({ connect }));

		expect(registry.list()).toEqual([
			expect.objectContaining({
				adapterId: 'vendor.distributed-sql',
				dialectId: 'postgresql',
				label: 'Distributed SQL',
			}),
		]);
		expect(registry.list()[0]).not.toHaveProperty('connect');
		expect(connect).not.toHaveBeenCalled();
	});

	it('refuses duplicates and registration after sealing', () => {
		const registry = createDatabaseAdapterRegistry();
		registry.register(descriptor());
		expect(() => registry.register(descriptor())).toThrow('already registered');
		registry.seal();
		expect(() =>
			registry.register(descriptor({ adapterId: 'vendor.second' })),
		).toThrow('sealed');
	});

	it('checks every active module against its selected adapter', () => {
		const registry = createDatabaseAdapterRegistry();
		registry.register(descriptor());
		const valid = validateDatabaseSelection(
			registry,
			{
				version: 1,
				defaultAdapterId: 'vendor.distributed-sql',
			},
			[
				{
					moduleId: 'profile.core',
					tenantOwned: true,
					dialectIds: ['postgresql'],
					capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
				},
			],
		);
		expect(valid).toEqual([]);

		const invalid = validateDatabaseSelection(
			registry,
			{
				version: 1,
				defaultAdapterId: 'vendor.distributed-sql',
				moduleOverrides: { 'profile.core': 'vendor.missing' },
			},
			[{ moduleId: 'profile.core', tenantOwned: true }],
		);
		expect(invalid).toEqual([
			expect.objectContaining({
				moduleId: 'profile.core',
				code: 'ADAPTER_NOT_REGISTERED',
			}),
		]);
	});

	it('requires RLS and transaction-local context for PostgreSQL tenant data', () => {
		const registry = createDatabaseAdapterRegistry();
		registry.register(
			descriptor({
				adapterId: 'vendor.unsafe-postgresql',
				capabilities: {
					features: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
					isolationLevels: ['read-committed'],
				},
			}),
		);

		expect(
			validateDatabaseSelection(
				registry,
				{ version: 1, defaultAdapterId: 'vendor.unsafe-postgresql' },
				[{ moduleId: 'profile.core', tenantOwned: true }],
			),
		).toContainEqual(
			expect.objectContaining({ code: 'POSTGRESQL_RLS_REQUIRED' }),
		);
	});
});
