import { createDataClassRegistry, type Actor } from '@flowdular/sdk/kernel';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CatalogService,
	EXPORT_PAGE,
} from '../src/services/catalog-service.ts';
import { catalogDataClasses } from '../src/services/data-classes.ts';
import {
	closeCatalogTestDatabases,
	createCatalogTestDatabase,
	type CatalogTestDatabase,
} from './support/database.ts';

const ACTOR: Actor = { kind: 'user', id: 'account-1', label: 'Ada' };

let database: CatalogTestDatabase;
let service: CatalogService;

beforeEach(async () => {
	database = await createCatalogTestDatabase();
	service = new CatalogService(database.repository);
});

afterEach(() => database.dispose());
afterAll(closeCatalogTestDatabases);

function declarations() {
	return catalogDataClasses(() => Promise.resolve(service));
}

function declared(key: string) {
	const declaration = declarations().find((entry) => entry.key === key);
	if (!declaration) throw new Error(`No data class ${key}.`);
	return declaration;
}

async function exported(key: string, tenantId: string) {
	const rows: Record<string, unknown>[] = [];
	const summary = await declared(key).export!({
		tenantId,
		sink: { write: async (row) => void rows.push(row) },
	});
	return { rows, summary };
}

function create(tenantId: string, sku: string) {
	return service.create(
		tenantId,
		{
			sku,
			name: `Item ${sku}`,
			kind: 'product',
			unit: 'pcs',
			basePriceMinor: 1_000,
			currency: 'PLN',
		},
		ACTOR,
	);
}

describe('catalog data classes', () => {
	it('declares one class per owned table the platform registry accepts', () => {
		const registry = createDataClassRegistry();
		registry.declare('catalog.core', declarations());
		registry.seal();

		const entry = registry
			.list()
			.find((module) => module.moduleId === 'catalog.core');
		expect(entry?.classes.map((declaration) => declaration.key)).toEqual([
			'items',
			'history',
			'idempotency-ledger',
		]);
		for (const key of ['items', 'history']) {
			const declaration = declared(key);
			expect(declaration.exportable).toBe(true);
			expect(declaration.export).toBeTypeOf('function');
			expect(declaration.defaultRetentionDays).toBeNull();
			expect(declaration.sweep).toBeUndefined();
			expect(declaration.erase).toBeUndefined();
		}
		const ledger = declared('idempotency-ledger');
		expect(ledger.exportable).toBe(false);
		expect(ledger.excludedReason).toBeTruthy();
		expect(ledger.export).toBeUndefined();
		expect(ledger.sweep).toBeUndefined();
	});

	it('exports the items and history of one tenant and none of another', async () => {
		const kept = await create('tenant-a', 'A-1');
		const archived = await create('tenant-a', 'A-2');
		await service.archive('tenant-a', archived.id, ACTOR);
		await create('tenant-b', 'B-1');

		const items = await exported('items', 'tenant-a');
		expect(items.rows.map((row) => row.sku)).toEqual(['A-1', 'A-2']);
		expect(items.rows[0]).toEqual({
			id: kept.id,
			sku: 'A-1',
			name: 'Item A-1',
			kind: 'product',
			unit: 'pcs',
			basePriceMinor: 1_000,
			currency: 'PLN',
			status: 'active',
			createdAt: new Date(kept.createdAt).toISOString(),
		});
		expect(items.summary).toEqual({
			rows: 2,
			from: new Date(kept.createdAt),
			to: new Date(archived.createdAt),
		});

		const history = await exported('history', 'tenant-a');
		expect(
			history.rows.map((row) => [row.recordId, row.action, row.version]),
		).toEqual([
			[kept.id, 'created', 1],
			[archived.id, 'created', 1],
			[archived.id, 'archived', 2],
		]);
		expect(history.rows[2]).toMatchObject({
			actor: ACTOR,
			changes: { status: { from: 'active', to: 'archived' } },
		});
		expect(history.summary.rows).toBe(3);
		expect(history.summary.from).toBeInstanceOf(Date);
		expect(history.summary.to).toBeInstanceOf(Date);
	});

	it('walks past one page and stays inside the tenant', async () => {
		const total = EXPORT_PAGE + 1;
		for (let index = 0; index < total; index += 1) {
			await create('tenant-a', `P-${String(index).padStart(3, '0')}`);
		}
		await create('tenant-b', 'B-1');

		const items = await exported('items', 'tenant-a');
		expect(items.summary.rows).toBe(total);
		expect(new Set(items.rows.map((row) => row.id)).size).toBe(total);
		expect(items.rows.some((row) => row.sku === 'B-1')).toBe(false);

		const history = await exported('history', 'tenant-a');
		expect(history.summary.rows).toBe(total);
		expect(new Set(history.rows.map((row) => row.id)).size).toBe(total);
	});

	it('reports an empty tenant without writing a row', async () => {
		await create('tenant-b', 'B-1');
		for (const key of ['items', 'history']) {
			const { rows, summary } = await exported(key, 'tenant-empty');
			expect(rows).toEqual([]);
			expect(summary).toEqual({ rows: 0, from: null, to: null });
		}
	});
});
