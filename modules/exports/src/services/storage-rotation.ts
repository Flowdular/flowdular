import type { DatabaseHandle } from '@flowdular/database';
import type { StorageResealCount, StorageResealPort } from '@flowdular/storage';
import { EXPORT_OWNER_MODULE } from './export-service.ts';

/** Objects walked inside one tenant-scoped transaction. */
export const STORAGE_ROTATION_BATCH = 200;

export const STORAGE_ROTATION_TABLE = 'exports_jobs';

export interface StorageRotationReport {
	readonly table: string;
	/** Key id every object should end on: the current key of the storage ring. */
	readonly currentKeyId: string;
	readonly counts: readonly StorageResealCount[];
	readonly tenants: number;
	/** Completed jobs that name a file. */
	readonly objects: number;
	/** Objects on a retired key the ring still holds when the run started. */
	readonly stale: number;
	readonly resealed: number;
	/** Objects under a key id the ring does not hold; left as they are. */
	readonly unknown: number;
	/** Objects that failed authentication; left as they are. */
	readonly refused: number;
	/** Jobs whose file the store no longer holds. */
	readonly missing: number;
}

export interface StorageRotationOptions {
	/** Tenant-scoped handle. Every row is read on it. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant handle. It is granted the routing columns and nothing else. */
	readonly background: DatabaseHandle;
	readonly storage: StorageResealPort;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

const SQL = {
	/* The cross-tenant role sees the job status and not the object id, so the
	   inventory names workspaces with completed jobs; the rows that carry a
	   file are read under each of them. */
	tenants: `SELECT tenant_id
	          FROM exports_jobs
	          WHERE status = 'completed'
	          GROUP BY tenant_id
	          ORDER BY tenant_id`,
	/* Paged by primary key. The rows are locked while their files are
	   rewritten, so the retention sweep deletes a row after the batch that
	   rewrote its file, never between the read and the write. */
	batch: `SELECT id, object_id
	        FROM exports_jobs
	        WHERE tenant_id = $1 AND object_id IS NOT NULL AND id > $2
	        ORDER BY id
	        LIMIT $3
	        FOR UPDATE`,
	inventoryBatch: `SELECT id, object_id
	                 FROM exports_jobs
	                 WHERE tenant_id = $1 AND object_id IS NOT NULL AND id > $2
	                 ORDER BY id
	                 LIMIT $3`,
};

/**
 * Re-seals every export file that is not on the current storage key. The
 * workspaces are listed once on the cross-tenant role, and each batch of jobs
 * is read under its own tenant; the files they name are read from the store,
 * and the stale ones rewritten in place. It is idempotent: a second run finds
 * nothing to do.
 */
export async function rotateExportObjects(
	options: StorageRotationOptions,
): Promise<StorageRotationReport> {
	const apply = options.apply === true;
	const batchSize = options.batchSize ?? STORAGE_ROTATION_BATCH;
	const inventory = await options.background.transaction(
		(transaction) =>
			transaction.query<{ tenant_id: string }>({ text: SQL.tenants }),
		{ access: 'read' },
	);
	const counts = new Map<string, number>();
	let objects = 0;
	let stale = 0;
	let resealed = 0;
	let unknown = 0;
	let refused = 0;
	let missing = 0;
	for (const { tenant_id: tenantId } of inventory.rows) {
		let cursor = '';
		for (;;) {
			const batch = await options.runtime.transaction(
				async (transaction) => {
					const rows = (
						await transaction.query<{ id: string; object_id: string }>({
							text: apply ? SQL.batch : SQL.inventoryBatch,
							parameters: [tenantId, cursor, batchSize],
						})
					).rows;
					const report = await options.storage.reseal(
						rows.map((row) => ({
							tenantId,
							moduleId: EXPORT_OWNER_MODULE,
							objectId: row.object_id,
						})),
						{ apply },
					);
					return { read: rows.length, last: rows.at(-1)?.id, report };
				},
				{ access: apply ? 'write' : 'read', tenantId },
			);
			objects += batch.read;
			for (const entry of batch.report.counts) {
				counts.set(entry.keyId, (counts.get(entry.keyId) ?? 0) + entry.objects);
			}
			stale += batch.report.stale;
			resealed += batch.report.resealed;
			unknown += batch.report.unknown;
			refused += batch.report.refused;
			missing += batch.report.missing;
			if (batch.read < batchSize || batch.last === undefined) break;
			cursor = batch.last;
		}
	}
	return {
		table: STORAGE_ROTATION_TABLE,
		currentKeyId: options.storage.keyId,
		counts: [...counts]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([keyId, total]) => ({ keyId, objects: total })),
		tenants: inventory.rows.length,
		objects,
		stale,
		resealed,
		unknown,
		refused,
		missing,
	};
}
