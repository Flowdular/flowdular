import type { DefinedListExport } from '@flowdular/sdk/server';
import { EXPORT_LISTS_CAPABILITY } from '@flowdular/sdk/modules/exports';
import type { PlatformServerContext } from '@flowdular/sdk/modules/auth/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CATALOG_ITEMS_EXPORT_LIST_ID } from '../src/domain/lists.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	createCatalogRuntime,
	type CatalogRuntime,
} from '../src/server/runtime.ts';
import {
	catalogTestProvider,
	closeCatalogTestDatabases,
} from './support/database.ts';

const ACTOR = { kind: 'user', id: 'account-a', label: 'Owner' } as const;

const disposals = new Set<() => Promise<void>>();

afterEach(async () => {
	await Promise.all([...disposals].map((dispose) => dispose()));
	disposals.clear();
});

afterAll(closeCatalogTestDatabases);

/* The composition context a test needs: leased databases, a capability map
   and inert registries for what this test does not observe. */
async function compose(registered: Map<string, readonly DefinedListExport[]>) {
	const capabilities = new Map<string, unknown>();
	capabilities.set(EXPORT_LISTS_CAPABILITY, {
		register: (moduleId: string, lists: readonly DefinedListExport[]) =>
			registered.set(moduleId, lists),
	});
	const context = {
		environment: { NODE_ENV: 'test' },
		databases: await catalogTestProvider(),
		auth: {},
		agentTools: { register: () => undefined },
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => capabilities.set(id, value),
			get: (id: string) => capabilities.get(id) ?? null,
			has: (id: string) => capabilities.has(id),
		},
	} as unknown as PlatformServerContext;
	const composition = createServerComposition(context);
	disposals.add(() => composition.dispose?.() ?? Promise.resolve());
	return composition;
}

async function seed(runtime: CatalogRuntime, tenantId: string, skus: string[]) {
	const service = await runtime.service();
	for (const sku of skus) {
		await service.create(
			tenantId,
			{
				sku,
				name: 'Item ' + sku,
				kind: 'product',
				unit: 'pcs',
				basePriceMinor: 1_000,
				currency: 'PLN',
			},
			ACTOR,
		);
	}
}

describe('catalog items list export', () => {
	it('registers catalog.core.items with its columns while composing', async () => {
		const registered = new Map<string, readonly DefinedListExport[]>();
		const composition = await compose(registered);
		composition.start?.();
		const lists = registered.get('catalog.core');
		expect(lists?.map((list) => list.id)).toEqual([
			CATALOG_ITEMS_EXPORT_LIST_ID,
		]);
		expect(lists?.[0]).toMatchObject({
			permission: 'catalog.items.read',
			columns: [
				{ key: 'sku' },
				{ key: 'name' },
				{ key: 'kind' },
				{ key: 'unit' },
				{ key: 'basePriceMinor' },
				{ key: 'currency' },
				{ key: 'status' },
			],
		});
		expect(lists?.[0]?.header.trim()).toBe(
			'SKU,Name,Kind,Unit,Base price (minor units),Currency,Status',
		);
	});

	it('streams one workspace in SKU order, page by page, and none of another', async () => {
		const registered = new Map<string, readonly DefinedListExport[]>();
		const composition = await compose(registered);
		const list = registered.get('catalog.core')![0]!;
		/* The composition owns its runtime; the rows are seeded through a second
		   one over the same cluster. */
		const runtime = createCatalogRuntime({
			databases: await catalogTestProvider(),
			purpose: 'test',
		});
		disposals.add(() => runtime.dispose());
		await seed(runtime, 'tenant-a', ['C-3', 'A-1', 'B-2', 'D-4', 'E-5']);
		await seed(runtime, 'tenant-b', ['Z-9']);
		const principal = {
			accountId: 'account-a',
			tenantId: 'tenant-a',
			scopes: ['catalog.items.read'],
		};

		const first = await list.page(principal, null, 2);
		expect(first.rows).toBe(2);
		expect(first.records.map((record) => record.split(',')[0])).toEqual([
			'A-1',
			'B-2',
		]);
		expect(first.nextCursor).not.toBeNull();
		const second = await list.page(principal, first.nextCursor, 2);
		expect(second.records.map((record) => record.split(',')[0])).toEqual([
			'C-3',
			'D-4',
		]);
		const third = await list.page(principal, second.nextCursor, 2);
		expect(third.records.map((record) => record.trim())).toEqual([
			'E-5,Item E-5,product,pcs,1000,PLN,active',
		]);
		expect(third.nextCursor).toBeNull();
		expect(composition.routes.length).toBeGreaterThan(0);
	});
});
