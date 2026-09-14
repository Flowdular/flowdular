import type { DatabaseHandle } from '@flowdular/database';
import type {
	StorageObjectRef,
	StorageResealCount,
	StorageResealPort,
} from '@flowdular/storage';

/** Objects walked inside one tenant-scoped transaction. */
export const STORAGE_ROTATION_BATCH = 200;

export const STORAGE_ROTATION_TABLE = 'documents_files';

export interface StorageRotationReport {
	readonly table: string;
	/** Key id every object should end on: the current key of the storage ring. */
	readonly currentKeyId: string;
	readonly counts: readonly StorageResealCount[];
	readonly tenants: number;
	/** Stored rows the pass walked. */
	readonly objects: number;
	/** Objects on a retired key the ring still holds when the run started. */
	readonly stale: number;
	readonly resealed: number;
	/** Objects under a key id the ring does not hold; left as they are. */
	readonly unknown: number;
	/** Objects that failed authentication; left as they are. */
	readonly refused: number;
	/** Stored rows whose object the store no longer holds. */
	readonly missing: number;
}

export interface StorageRotationOptions {
	/** Tenant-scoped handle. Every row is read on it. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant handle. It is granted the tenant id and the status and nothing else. */
	readonly background: DatabaseHandle;
	readonly storage: StorageResealPort;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

const SQL = {
	tenants: `SELECT tenant_id, count(*) AS row_count
	          FROM documents_files
	          WHERE status = 'stored'
	          GROUP BY tenant_id
	          ORDER BY tenant_id`,
	/* Paged by primary key. The rows are locked while their objects are
	   rewritten, so a delete that marks one of them waits for the batch and
	   then removes the re-sealed object instead of racing its rewrite. */
	batch: `SELECT id, storage_key
	        FROM documents_files
	        WHERE tenant_id = $1 AND status = 'stored' AND id > $2
	        ORDER BY id
	        LIMIT $3
	        FOR UPDATE`,
	inventoryBatch: `SELECT id, storage_key
	                 FROM documents_files
	                 WHERE tenant_id = $1 AND status = 'stored' AND id > $2
	                 ORDER BY id
	                 LIMIT $3`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The documents database returned an invalid count.');
	}
	return normalized;
}

/* The row is the inventory, and its key names the tenant it was written under;
   a row whose key names another tenant is a defect, not an object to rewrite. */
function referenceOf(tenantId: string, storageKey: string): StorageObjectRef {
	const [tenant, moduleId, objectId, ...rest] = storageKey.split('/');
	if (tenant !== tenantId || !moduleId || !objectId || rest.length > 0) {
		throw new Error(
			`A documents_files row of ${tenantId} names the storage key ${storageKey}, which is not one of its objects.`,
		);
	}
	return { tenantId, moduleId, objectId };
}

/**
 * Re-seals every stored document object that is not on the current storage
 * key. The workspaces are listed once on the cross-tenant role, and each batch
 * of rows is read under its own tenant; the objects they name are read from
 * the store, and the stale ones rewritten in place. It is idempotent: a second
 * run finds nothing to do.
 */
export async function rotateDocumentObjects(
	options: StorageRotationOptions,
): Promise<StorageRotationReport> {
	const apply = options.apply === true;
	const batchSize = options.batchSize ?? STORAGE_ROTATION_BATCH;
	const inventory = await options.background.transaction(
		(transaction) =>
			transaction.query<{
				tenant_id: string;
				row_count: number | bigint | string;
			}>({ text: SQL.tenants }),
		{ access: 'read' },
	);
	const counts = new Map<string, number>();
	let objects = 0;
	let stale = 0;
	let resealed = 0;
	let unknown = 0;
	let refused = 0;
	let missing = 0;
	for (const { tenant_id: tenantId, row_count: rowCount } of inventory.rows) {
		objects += count(rowCount);
		let cursor = '';
		for (;;) {
			const batch = await options.runtime.transaction(
				async (transaction) => {
					const rows = (
						await transaction.query<{ id: string; storage_key: string }>({
							text: apply ? SQL.batch : SQL.inventoryBatch,
							parameters: [tenantId, cursor, batchSize],
						})
					).rows;
					const report = await options.storage.reseal(
						rows.map((row) => referenceOf(tenantId, row.storage_key)),
						{ apply },
					);
					return { read: rows.length, last: rows.at(-1)?.id, report };
				},
				{ access: apply ? 'write' : 'read', tenantId },
			);
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
