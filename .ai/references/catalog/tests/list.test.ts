import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CatalogItem, CatalogListSort } from '../src/domain/types.ts';
import {
	CatalogService,
	FIRST_LIST_PAGE,
	type CatalogListInput,
} from '../src/services/catalog-service.ts';
import { listStatement } from '../src/services/database-repository.ts';
import {
	closeCatalogTestDatabases,
	createCatalogTestDatabase,
	type CatalogTestDatabase,
} from './support/database.ts';

const ACTOR = { kind: 'user', id: 'account-1', label: 'Test user' } as const;

const databases = new Set<CatalogTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeCatalogTestDatabases);

async function fixture(): Promise<CatalogTestDatabase> {
	const database = await createCatalogTestDatabase();
	databases.add(database);
	return database;
}

/* Names collide in case and prefix, SKUs sort differently from names, and the
   update times are spread by the mutations below, so each order is its own. */
const SEED = [
	['B-2', 'bolt', 'product'],
	['A-1', 'Bolt', 'product'],
	['C-3', 'Anchor', 'service'],
	['D-4', 'anchor plate', 'product'],
	['E-5', 'Washer', 'service'],
	['F-6', 'washer_wide', 'product'],
	['G-7', '50% nut', 'product'],
] as const;

async function seed(
	service: CatalogService,
	tenantId = 'tenant-a',
): Promise<readonly CatalogItem[]> {
	const items: CatalogItem[] = [];
	for (const [sku, name, kind] of SEED) {
		items.push(
			await service.create(
				tenantId,
				{ sku, name, kind, unit: 'pcs', basePriceMinor: 100, currency: 'EUR' },
				ACTOR,
			),
		);
	}
	return items;
}

/* The unbounded order, read once by the same ORDER BY the page uses. */
async function unbounded(
	database: CatalogTestDatabase,
	sort: CatalogListSort,
	direction: 'asc' | 'desc',
	tenantId = 'tenant-a',
): Promise<readonly string[]> {
	const expression = {
		name: 'lower(name)',
		sku: 'sku_normalized',
		updatedAt: 'updated_at',
	}[sort];
	const order = direction === 'asc' ? 'ASC' : 'DESC';
	const result = await database.runtime.transaction(
		(transaction) =>
			transaction.query<{ id: string }>({
				text: `SELECT id FROM catalog_items WHERE tenant_id = $1
				       ORDER BY ${expression} ${order}, id ${order}`,
				parameters: [tenantId],
			}),
		{ access: 'read', tenantId },
	);
	return result.rows.map((row) => row.id);
}

async function walk(
	service: CatalogService,
	input: Omit<CatalogListInput, 'after'>,
): Promise<readonly string[]> {
	const ids: string[] = [];
	let after: CatalogListInput['after'] = null;
	for (;;) {
		const page = await service.listPage('tenant-a', { ...input, after });
		ids.push(...page.items.map((item) => item.id));
		if (page.next === null) return ids;
		after = page.next;
	}
}

describe('catalog list pages', () => {
	it('walks every order in pages of two exactly as the unbounded order reads', async () => {
		const database = await fixture();
		const service = new CatalogService(database.repository);
		const items = await seed(service);
		await seed(service, 'tenant-b');
		/* Spread the update times so the recency order differs from creation. */
		await service.archive('tenant-a', items[2]!.id, ACTOR);
		await service.update(
			'tenant-a',
			{ ...items[5]!, name: 'washer_wide', basePriceMinor: 120 },
			ACTOR,
		);
		for (const sort of ['name', 'sku', 'updatedAt'] as const) {
			for (const direction of ['asc', 'desc'] as const) {
				const expected = await unbounded(database, sort, direction);
				expect(expected, `${sort} ${direction}`).toHaveLength(SEED.length);
				expect(
					await walk(service, {
						...FIRST_LIST_PAGE,
						sort,
						direction,
						limit: 2,
					}),
					`${sort} ${direction}`,
				).toEqual(expected);
			}
		}
	});

	it('hands a cursor back only on a full page', async () => {
		const service = new CatalogService((await fixture()).repository);
		await seed(service);
		const full = await service.listPage('tenant-a', {
			...FIRST_LIST_PAGE,
			limit: SEED.length,
		});
		expect(full.items).toHaveLength(SEED.length);
		expect(full.next).not.toBeNull();
		const rest = await service.listPage('tenant-a', {
			...FIRST_LIST_PAGE,
			limit: SEED.length,
			after: full.next,
		});
		expect(rest).toEqual({ items: [], next: null });
		const short = await service.listPage('tenant-a', {
			...FIRST_LIST_PAGE,
			limit: SEED.length + 1,
		});
		expect(short.items).toHaveLength(SEED.length);
		expect(short.next).toBeNull();
	});

	it('narrows by kind, status and a literal search in SQL', async () => {
		const service = new CatalogService((await fixture()).repository);
		const items = await seed(service);
		await service.archive('tenant-a', items[0]!.id, ACTOR);
		const skus = async (input: Partial<CatalogListInput>) =>
			(
				await service.listPage('tenant-a', { ...FIRST_LIST_PAGE, ...input })
			).items.map((item) => item.sku);

		expect(await skus({ kind: 'service', sort: 'sku' })).toEqual([
			'C-3',
			'E-5',
		]);
		expect(await skus({ status: 'archived' })).toEqual(['B-2']);
		expect(
			await skus({ status: 'active', kind: 'product', sort: 'sku' }),
		).toEqual(['A-1', 'D-4', 'F-6', 'G-7']);
		expect(await skus({ search: 'BOLT', sort: 'sku' })).toEqual(['A-1', 'B-2']);
		expect(await skus({ search: 'a-1' })).toEqual(['A-1']);
		expect(await skus({ search: '%' })).toEqual(['G-7']);
		expect(await skus({ search: '_wide' })).toEqual(['F-6']);
		expect(await skus({ search: 'nothing-here' })).toEqual([]);
	});

	it('refuses an unknown sort, direction, limit or filter before reading', async () => {
		const service = new CatalogService((await fixture()).repository);
		await expect(
			service.listPage('tenant-a', {
				...FIRST_LIST_PAGE,
				sort: 'price' as CatalogListSort,
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			service.listPage('tenant-a', { ...FIRST_LIST_PAGE, limit: 201 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			service.listPage('tenant-a', {
				...FIRST_LIST_PAGE,
				kind: 'bundle' as CatalogItem['kind'],
			}),
		).rejects.toMatchObject({ code: 'INVALID_ITEM_KIND' });
	});

	it('orders by the indexed expression and binds every value', () => {
		const statement = listStatement('tenant-a', {
			sort: 'name',
			direction: 'desc',
			kind: 'product',
			status: null,
			term: 'bo%lt',
			limit: 50,
			after: { sortValue: 'bolt', id: 'item-1' },
		});
		expect(statement.text).toContain('ORDER BY lower(name) DESC, id DESC');
		expect(statement.text).toContain('(lower(name), id) <');
		expect(statement.parameters).toEqual([
			'tenant-a',
			'product',
			'%bo\\%lt%',
			'bolt',
			'item-1',
			50,
		]);
	});
});
