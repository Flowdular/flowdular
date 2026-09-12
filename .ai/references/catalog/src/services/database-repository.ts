import { randomUUID } from 'node:crypto';
import type {
	DatabaseHandle,
	DatabaseTransaction,
} from '@flowdular/sdk/database';
import {
	appendRecordHistory,
	queryRecordHistory,
	runDatabaseMigrations,
} from '@flowdular/sdk/database';
import {
	diffFields,
	type Actor,
	type HistoryEntry,
	type HistoryPage,
	type HistoryQuery,
	type RecordChanges,
	type TrackedFields,
	type UserActor,
} from '@flowdular/sdk/kernel';
import type { CatalogItem } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import {
	DuplicateSkuError,
	type CatalogRepository,
	type ExportCursor,
} from './repository.ts';
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

/* Queries stay explicit. Catalog data never passes through a SQL rewriter, and
   values always use the adapter's parameter channel. */
const LIST = `SELECT ${COLUMNS} FROM catalog_items
			 WHERE tenant_id = $1 ORDER BY sku_normalized, id`;

const LIST_FOR_EXPORT = `SELECT ${COLUMNS} FROM catalog_items
			 WHERE tenant_id = $1
			   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
			 ORDER BY created_at, id LIMIT $4`;

const LIST_HISTORY_FOR_EXPORT = `SELECT id, record_id, version, action, actor_kind,
			  actor_id, actor_label, run_id, configured_by_json, changes_json, occurred_at
			 FROM ${HISTORY_TABLE}
			 WHERE tenant_id = $1
			   AND ($2::bigint IS NULL OR (occurred_at, id) > ($2::bigint, $3::text))
			 ORDER BY occurred_at, id LIMIT $4`;

const FIND = `SELECT ${COLUMNS} FROM catalog_items WHERE tenant_id = $1 AND id = $2`;

const INSERT = `INSERT INTO catalog_items
			 (id, tenant_id, sku, sku_normalized, name, kind, unit,
			  base_price_minor, currency, status, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

const UPDATE = `UPDATE catalog_items
			 SET name = $1, kind = $2, unit = $3, base_price_minor = $4, currency = $5
			 WHERE tenant_id = $6 AND id = $7 RETURNING ${COLUMNS}`;

const SET_STATUS = `UPDATE catalog_items SET status = $1 WHERE tenant_id = $2 AND id = $3
			 RETURNING ${COLUMNS}`;

const DELETE = 'DELETE FROM catalog_items WHERE tenant_id = $1 AND id = $2';

const FIND_IDEMPOTENCY = `SELECT operation_id, input_digest, result_json, result_digest
			 FROM catalog_idempotency_ledger
			 WHERE tenant_id = $1 AND idempotency_key = $2`;

const RECORD_IDEMPOTENCY = `INSERT INTO catalog_idempotency_ledger
			 (id, tenant_id, idempotency_key, operation_id, input_digest,
			  outcome, result_json, result_digest, created_at)
			 VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8)`;

interface CatalogItemRow {
	id: string;
	tenant_id: string;
	sku: string;
	name: string;
	kind: CatalogItem['kind'];
	unit: string;
	base_price_minor: number | bigint | string;
	currency: string;
	status: CatalogItem['status'];
	created_at: number | bigint | string;
}

interface HistoryRow {
	id: string;
	record_id: string;
	version: number | bigint | string;
	action: string;
	actor_kind: Actor['kind'];
	actor_id: string;
	actor_label: string;
	run_id: string | null;
	configured_by_json: string | null;
	changes_json: string;
	occurred_at: number | bigint | string;
}

interface IdempotencyRow {
	operation_id: string;
	input_digest: string;
	result_json: string;
	result_digest: string;
}

/* 23505 is the SQLSTATE for a unique violation; the constraint name keeps a
   different unique index on the table from being mistaken for the SKU. The
   driver text is never surfaced, only the stable domain error. */
function isDuplicateSku(error: unknown): boolean {
	const cause = error as { code?: unknown; constraint?: unknown };
	const text = String(error);
	return (
		(cause?.code === '23505' || text.includes('23505')) &&
		(String(cause?.constraint ?? '').includes('sku_normalized') ||
			text.includes('sku_normalized'))
	);
}

/* PostgreSQL returns BIGINT as a string, so every integer read crosses this
   instead of trusting the driver's representation. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The catalog database returned an invalid ${field}.`);
	}
	return normalized;
}

function fromRow(row: CatalogItemRow): CatalogItem {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sku: row.sku,
		name: row.name,
		kind: row.kind,
		unit: row.unit,
		basePriceMinor: integer(row.base_price_minor, 'price'),
		currency: row.currency,
		status: row.status,
		createdAt: integer(row.created_at, 'timestamp'),
	};
}

function actorFromRow(row: HistoryRow): Actor {
	const identity = { id: row.actor_id, label: row.actor_label };
	if (row.actor_kind === 'user') return { kind: 'user', ...identity };
	if (row.actor_kind === 'agent' && row.run_id !== null) {
		return { kind: 'agent', ...identity, runId: row.run_id };
	}
	if (row.actor_kind === 'service' && row.configured_by_json !== null) {
		return {
			kind: 'service',
			...identity,
			configuredBy: JSON.parse(row.configured_by_json) as UserActor,
		};
	}
	throw new Error(
		`The catalog history table returned an invalid actor for "${row.id}".`,
	);
}

function historyFromRow(row: HistoryRow): HistoryEntry {
	return {
		id: row.id,
		recordId: row.record_id,
		version: integer(row.version, 'version'),
		action: row.action,
		actor: actorFromRow(row),
		changes: JSON.parse(row.changes_json) as RecordChanges,
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

/* The fields a history version reports on. Identity, tenancy and creation time
   cannot change and are never part of a diff. */
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

export async function migrateCatalogDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'catalog.core', databaseMigrations);
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseCatalogRepository implements CatalogRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	async list(tenantId: string): Promise<readonly CatalogItem[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CatalogItemRow>({
					text: LIST,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async listItemsForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly CatalogItem[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CatalogItemRow>({
					text: LIST_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async listHistoryForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly HistoryEntry[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<HistoryRow>({
					text: LIST_HISTORY_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(historyFromRow);
	}

	async find(tenantId: string, id: string): Promise<CatalogItem | null> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CatalogItemRow>({
					text: FIND,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async create(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
	): Promise<CatalogItem> {
		await this.readyPromise;
		try {
			return await this.database.transaction(
				(transaction) => this.#insert(transaction, item, normalizedSku, actor),
				{ access: 'write', tenantId: item.tenantId },
			);
		} catch (error) {
			if (isDuplicateSku(error)) throw new DuplicateSkuError();
			throw error;
		}
	}

	async createIdempotent(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<CatalogItem> {
		await this.readyPromise;
		try {
			return await this.database.transaction(
				async (transaction) => {
					const existing = await this.#idempotencyEntry(
						transaction,
						item.tenantId,
						idempotency.key,
					);
					if (existing) {
						if (
							existing.operationId !== idempotency.operationId ||
							existing.inputDigest !== idempotency.inputDigest
						) {
							throw new TargetIdempotencyConflictError();
						}
						return this.#result(existing, item.tenantId);
					}

					const created = await this.#insert(
						transaction,
						item,
						normalizedSku,
						actor,
					);
					await transaction.execute({
						text: RECORD_IDEMPOTENCY,
						parameters: [
							randomUUID(),
							item.tenantId,
							idempotency.key,
							idempotency.operationId,
							idempotency.inputDigest,
							JSON.stringify(created),
							canonicalDigest(created),
							Date.now(),
						],
					});
					return created;
				},
				{ access: 'write', tenantId: item.tenantId },
			);
		} catch (error) {
			if (isDuplicateSku(error)) throw new DuplicateSkuError();
			throw error;
		}
	}

	async update(item: CatalogItem, actor: Actor): Promise<CatalogItem | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, item.tenantId, item.id);
				if (!before) return null;
				const result = await transaction.query<CatalogItemRow>({
					text: UPDATE,
					parameters: [
						item.name,
						item.kind,
						item.unit,
						item.basePriceMinor,
						item.currency,
						item.tenantId,
						item.id,
					],
				});
				const row = result.rows[0];
				if (!row) return null;
				const after = fromRow(row);
				const changes = diffFields(tracked(before), tracked(after));
				if (Object.keys(changes).length > 0) {
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId: item.tenantId,
						recordId: after.id,
						action: 'updated',
						actor,
						changes,
						occurredAt: Date.now(),
					});
				}
				return after;
			},
			{ access: 'write', tenantId: item.tenantId },
		);
	}

	async setStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): Promise<CatalogItem | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, tenantId, id);
				if (!before) return null;
				const result = await transaction.query<CatalogItemRow>({
					text: SET_STATUS,
					parameters: [status, tenantId, id],
				});
				const row = result.rows[0];
				if (!row) return null;
				const after = fromRow(row);
				if (before.status !== after.status) {
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId,
						recordId: id,
						action: status === 'archived' ? 'archived' : 'restored',
						actor,
						changes: diffFields(tracked(before), tracked(after)),
						occurredAt: Date.now(),
					});
				}
				return after;
			},
			{ access: 'write', tenantId },
		);
	}

	async delete(tenantId: string, id: string, actor: Actor): Promise<boolean> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, tenantId, id);
				if (!before) return false;
				await appendRecordHistory(transaction, HISTORY_TABLE, {
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
				const result = await transaction.execute({
					text: DELETE,
					parameters: [tenantId, id],
				});
				return result.affectedRows === 1;
			},
			{ access: 'write', tenantId },
		);
	}

	async history(query: HistoryQuery): Promise<HistoryPage> {
		await this.readyPromise;
		return this.database.transaction(
			(transaction) => queryRecordHistory(transaction, HISTORY_TABLE, query),
			{ access: 'read', tenantId: query.tenantId },
		);
	}

	async #find(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
	): Promise<CatalogItem | null> {
		const result = await transaction.query<CatalogItemRow>({
			text: FIND,
			parameters: [tenantId, id],
		});
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async #insert(
		transaction: DatabaseTransaction,
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
	): Promise<CatalogItem> {
		await transaction.execute({
			text: INSERT,
			parameters: [
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
			],
		});
		await appendRecordHistory(transaction, HISTORY_TABLE, {
			tenantId: item.tenantId,
			recordId: item.id,
			action: 'created',
			actor,
			changes: diffFields(null, tracked(item)),
			occurredAt: item.createdAt,
		});
		return item;
	}

	async #idempotencyEntry(
		transaction: DatabaseTransaction,
		tenantId: string,
		key: string,
	): Promise<TargetIdempotencyEntry | null> {
		const result = await transaction.query<IdempotencyRow>({
			text: FIND_IDEMPOTENCY,
			parameters: [tenantId, key],
		});
		const row = result.rows[0];
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
		) {
			throw new TargetIdempotencyCorruptionError();
		}
		return result;
	}
}
