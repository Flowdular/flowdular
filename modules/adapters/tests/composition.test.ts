import { describe, expect, it } from 'vitest';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import type { DefinedListExport } from '@flowdular/server';
import { moduleDefinition } from '../src/index.ts';
import {
	ADAPTERS_SINKS_CAPABILITY,
	ADAPTERS_SOURCES_CAPABILITY,
	type AdapterRegistry,
} from '../src/domain/registry.ts';
import {
	activePrincipal,
	createServerComposition,
	workspaceTimeZone,
} from '../src/platform.ts';
import { sourceRegistration } from './support/service.ts';

describe('adapters.core composition', () => {
	it('declares its identity, the capabilities it provides and the optional ones it resolves', () => {
		expect(moduleDefinition.manifest.id).toBe('adapters.core');
		expect(moduleDefinition.manifest.provides).toEqual([
			ADAPTERS_SOURCES_CAPABILITY,
			ADAPTERS_SINKS_CAPABILITY,
		]);
		expect(
			moduleDefinition.manifest.requires?.every(
				(entry) => entry.optional === true,
			),
		).toBe(true);
		expect(moduleDefinition.permissions).toEqual([
			'adapters.runs.read',
			'adapters.runs.manage',
		]);
	});

	it('registers both registries, the data classes, the meter and the run list, and seals the catalogue at start', async () => {
		const registered = new Map<string, unknown>();
		const declared: { moduleId: string; keys: string[] }[] = [];
		const meters: { moduleId: string; keys: string[] }[] = [];
		const lists: { moduleId: string; ids: string[] }[] = [];
		const databases = createTestDatabaseProvider();
		const composition = createServerComposition({
			environment: { NODE_ENV: 'test' },
			databases,
			auth: {},
			settings: {},
			dataClasses: {
				declare: (moduleId: string, classes: { key: string }[]) =>
					declared.push({ moduleId, keys: classes.map((entry) => entry.key) }),
			},
			capabilities: {
				register: (id: string, value: unknown) => registered.set(id, value),
				get: (id: string) => {
					if (id === 'metering.meters.v1') {
						return {
							declare: (moduleId: string, entries: { key: string }[]) =>
								meters.push({
									moduleId,
									keys: entries.map((entry) => entry.key),
								}),
							record: async () => ({}),
						};
					}
					if (id === 'exports.lists.v1') {
						return {
							register: (moduleId: string, entries: DefinedListExport[]) =>
								lists.push({ moduleId, ids: entries.map((entry) => entry.id) }),
							find: () => null,
						};
					}
					return null;
				},
			},
		} as never);
		try {
			const sources = registered.get(
				ADAPTERS_SOURCES_CAPABILITY,
			) as AdapterRegistry;
			const sinks = registered.get(
				ADAPTERS_SINKS_CAPABILITY,
			) as AdapterRegistry;
			sources.register('vendors.core', [sourceRegistration()]);
			expect(typeof sinks.register).toBe('function');
			expect(declared).toEqual([
				{
					moduleId: 'adapters.core',
					keys: ['run-rows', 'runs', 'bindings', 'audit'],
				},
			]);
			expect(meters).toEqual([{ moduleId: 'adapters.core', keys: ['rows'] }]);
			expect(lists).toEqual([
				{ moduleId: 'adapters.core', ids: ['adapters.core.runs'] },
			]);

			composition.start?.();
			expect(() =>
				sources.register('vendors.core', [
					sourceRegistration({ id: 'vendors.core.late' }),
				]),
			).toThrow(expect.objectContaining({ code: 'ADAPTER_REGISTRY_SEALED' }));
			expect(meters).toHaveLength(1);
			expect(lists).toHaveLength(1);
		} finally {
			await composition.stop?.();
			await composition.dispose?.();
			await databases.dispose();
		}
	});

	it('acts for an active member only and falls back to UTC for a zone it cannot use', async () => {
		const members: Record<string, unknown> = {
			active: {
				accountId: 'active',
				email: 'a@example.com',
				displayName: 'A',
				role: 'owner',
				status: 'active',
				membershipStatus: 'active',
				scopes: ['adapters.runs.manage'],
			},
			suspended: {
				accountId: 'suspended',
				status: 'active',
				membershipStatus: 'disabled',
				scopes: [],
			},
		};
		const resolve = activePrincipal({
			auth: {
				service: async () => ({
					findTenantMember: async (_tenantId: string, accountId: string) =>
						members[accountId] ?? null,
				}),
			},
		} as never);
		expect(await resolve('tenant-a', 'active')).toMatchObject({
			accountId: 'active',
			tenantId: 'tenant-a',
			scopes: ['adapters.runs.manage'],
		});
		expect(await resolve('tenant-a', 'suspended')).toBeNull();
		expect(await resolve('tenant-a', 'gone')).toBeNull();

		const zone = (value: string | Error) =>
			workspaceTimeZone({
				settings: {
					prime: async () => undefined,
					get: () => {
						if (value instanceof Error) throw value;
						return value;
					},
				},
			} as never)('tenant-a');
		expect(await zone('Europe/Warsaw')).toBe('Europe/Warsaw');
		expect(await zone('Mars/Olympus')).toBe('UTC');
		expect(await zone(new Error('not declared'))).toBe('UTC');
	});
});
