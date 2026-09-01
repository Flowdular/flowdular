import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogItem } from '../domain/types.ts';
import { CATALOG_MIGRATION_001 } from './migration.ts';
import { DuplicateSkuError, type CatalogRepository } from './repository.ts';

interface CatalogItemRow {
	id: string;
	tenant_id: string;
	sku: string;
	name: string;
	kind: CatalogItem['kind'];
	unit: string;
	base_price_minor: number;
	currency: string;
	status: CatalogItem['status'];
	created_at: number;
}

function fromRow(row: CatalogItemRow): CatalogItem {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sku: row.sku,
		name: row.name,
		kind: row.kind,
		unit: row.unit,
		basePriceMinor: row.base_price_minor,
		currency: row.currency,
		status: row.status,
		createdAt: row.created_at,
	};
}

export class SqliteCatalogRepository implements CatalogRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(CATALOG_MIGRATION_001);
	}

	list(tenantId: string): readonly CatalogItem[] {
		return (
			this.#database
				.prepare(
					`SELECT id, tenant_id, sku, name, kind, unit, base_price_minor,
					 currency, status, created_at FROM catalog_items
					 WHERE tenant_id = ? ORDER BY sku_normalized, id`,
				)
				.all(tenantId) as unknown as CatalogItemRow[]
		).map(fromRow);
	}

	create(item: CatalogItem, normalizedSku: string): CatalogItem {
		try {
			this.#database
				.prepare(
					`INSERT INTO catalog_items
					 (id, tenant_id, sku, sku_normalized, name, kind, unit,
					  base_price_minor, currency, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					item.id,
					item.tenantId,
					item.sku,
					normalizedSku,
					item.name,
					item.kind,
					item.unit,
					item.basePriceMinor,
					item.currency,
					item.status,
					item.createdAt,
				);
		} catch (error) {
			if (String(error).includes('catalog_items.tenant_id')) {
				throw new DuplicateSkuError();
			}
			throw error;
		}
		return item;
	}
}
