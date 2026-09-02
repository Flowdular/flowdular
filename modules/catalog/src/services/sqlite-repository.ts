import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
	appendHistory,
	diffFields,
	inTransaction,
	queryHistory,
	runModuleMigrations,
	type Actor,
	type HistoryPage,
	type HistoryQuery,
	type TrackedFields,
} from '@coreloom/kernel';
import type { CatalogItem } from '../domain/types.ts';
import { migrations } from './migration.ts';
import { DuplicateSkuError, type CatalogRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyCorruptionError,
	TargetIdempotencyConflictError,
	type TargetIdempotencyEntry,
	type TargetIdempotencyRequest,
} from './target-idempotency.ts';

const HISTORY_TABLE = 'catalog_items_history_v2';
const COLUMNS = `id, tenant_id, sku, name, kind, unit, base_price_minor,
	currency, status, created_at`;

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

/* The fields a history version reports on. Identity, tenancy, and creation
   time are not changeable and are never part of a diff. */
function tracked(item: CatalogItem): TrackedFields {
	return {
		sku: item.sku,
		name: item.name,
		kind: item.kind,
		unit: item.unit,
		basePriceMinor: item.basePriceMinor,
		currency: item.currency,
		status: item.status,
	};
}

export class SqliteCatalogRepository implements CatalogRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
	}

	list(tenantId: string): readonly CatalogItem[] {
		return (
			this.#database
				.prepare(
					`SELECT ${COLUMNS} FROM catalog_items
					 WHERE tenant_id = ? ORDER BY sku_normalized, id`,
				)
				.all(tenantId) as unknown as CatalogItemRow[]
		).map(fromRow);
	}

	find(tenantId: string, id: string): CatalogItem | null {
		const row = this.#database
			.prepare(
				`SELECT ${COLUMNS} FROM catalog_items WHERE tenant_id = ? AND id = ?`,
			)
			.get(tenantId, id) as unknown as CatalogItemRow | undefined;
		return row ? fromRow(row) : null;
	}

	create(item: CatalogItem, normalizedSku: string, actor: Actor): CatalogItem {
		try {
			return inTransaction(this.#database, () =>
				this.#insert(item, normalizedSku, actor),
			);
		} catch (error) {
			if (String(error).includes('catalog_items.tenant_id')) {
				throw new DuplicateSkuError();
			}
			throw error;
		}
	}

	createIdempotent(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): CatalogItem {
		try {
			return inTransaction(this.#database, () => {
				const existing = this.#idempotencyEntry(item.tenantId, idempotency.key);
				if (existing) {
					if (
						existing.operationId !== idempotency.operationId ||
						existing.inputDigest !== idempotency.inputDigest
					) {
						throw new TargetIdempotencyConflictError();
					}
					return this.#result(existing, item.tenantId);
				}

				const created = this.#insert(item, normalizedSku, actor);
				const resultJson = JSON.stringify(created);
				this.#database
					.prepare(
						`INSERT INTO catalog_idempotency_ledger
						 (id, tenant_id, idempotency_key, operation_id, input_digest,
						  outcome, result_json, result_digest, created_at)
						 VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
					)
					.run(
						randomUUID(),
						item.tenantId,
						idempotency.key,
						idempotency.operationId,
						idempotency.inputDigest,
						resultJson,
						canonicalDigest(created),
						Date.now(),
					);
				return created;
			});
		} catch (error) {
			if (String(error).includes('catalog_items.tenant_id')) {
				throw new DuplicateSkuError();
			}
			throw error;
		}
	}

	update(item: CatalogItem, actor: Actor): CatalogItem | null {
		return inTransaction(this.#database, () => {
			const before = this.find(item.tenantId, item.id);
			if (!before) return null;
			const row = this.#database
				.prepare(
					`UPDATE catalog_items
					 SET name = ?, kind = ?, unit = ?, base_price_minor = ?, currency = ?
					 WHERE tenant_id = ? AND id = ? RETURNING ${COLUMNS}`,
				)
				.get(
					item.name,
					item.kind,
					item.unit,
					item.basePriceMinor,
					item.currency,
					item.tenantId,
					item.id,
				) as unknown as CatalogItemRow | undefined;
			if (!row) return null;
			const after = fromRow(row);
			const changes = diffFields(tracked(before), tracked(after));
			if (Object.keys(changes).length > 0) {
				appendHistory(this.#database, HISTORY_TABLE, {
					tenantId: item.tenantId,
					recordId: item.id,
					action: 'updated',
					actor,
					changes,
					occurredAt: Date.now(),
				});
			}
			return after;
		});
	}

	setStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): CatalogItem | null {
		return inTransaction(this.#database, () => {
			const before = this.find(tenantId, id);
			if (!before) return null;
			const row = this.#database
				.prepare(
					`UPDATE catalog_items SET status = ? WHERE tenant_id = ? AND id = ?
					 RETURNING ${COLUMNS}`,
				)
				.get(status, tenantId, id) as unknown as CatalogItemRow | undefined;
			if (!row) return null;
			const after = fromRow(row);
			if (before.status !== after.status) {
				appendHistory(this.#database, HISTORY_TABLE, {
					tenantId,
					recordId: id,
					action: status === 'archived' ? 'archived' : 'restored',
					actor,
					changes: diffFields(tracked(before), tracked(after)),
					occurredAt: Date.now(),
				});
			}
			return after;
		});
	}

	delete(tenantId: string, id: string, actor: Actor): boolean {
		return inTransaction(this.#database, () => {
			const before = this.find(tenantId, id);
			if (!before) return false;
			appendHistory(this.#database, HISTORY_TABLE, {
				tenantId,
				recordId: id,
				action: 'deleted',
				actor,
				changes: diffFields(tracked(before), {
					sku: null,
					name: null,
					kind: null,
					unit: null,
					basePriceMinor: null,
					currency: null,
					status: null,
				}),
				occurredAt: Date.now(),
			});
			return (
				this.#database
					.prepare('DELETE FROM catalog_items WHERE tenant_id = ? AND id = ?')
					.run(tenantId, id).changes === 1
			);
		});
	}

	history(query: HistoryQuery): HistoryPage {
		return queryHistory(this.#database, HISTORY_TABLE, query);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	#insert(item: CatalogItem, normalizedSku: string, actor: Actor): CatalogItem {
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
		appendHistory(this.#database, HISTORY_TABLE, {
			tenantId: item.tenantId,
			recordId: item.id,
			action: 'created',
			actor,
			changes: diffFields(null, tracked(item)),
			occurredAt: item.createdAt,
		});
		return item;
	}

	#idempotencyEntry(
		tenantId: string,
		key: string,
	): TargetIdempotencyEntry | null {
		const row = this.#database
			.prepare(
				`SELECT operation_id, input_digest, result_json, result_digest
				 FROM catalog_idempotency_ledger
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, key) as
			| {
					operation_id: string;
					input_digest: string;
					result_json: string;
					result_digest: string;
			  }
			| undefined;
		return row
			? {
					operationId: row.operation_id,
					inputDigest: row.input_digest,
					resultJson: row.result_json,
					resultDigest: row.result_digest,
				}
			: null;
	}

	#result(entry: TargetIdempotencyEntry, tenantId: string): CatalogItem {
		let result: CatalogItem;
		try {
			result = JSON.parse(entry.resultJson) as CatalogItem;
		} catch {
			throw new TargetIdempotencyCorruptionError();
		}
		if (
			result.tenantId !== tenantId ||
			canonicalDigest(result) !== entry.resultDigest
		)
			throw new TargetIdempotencyCorruptionError();
		return result;
	}
}
