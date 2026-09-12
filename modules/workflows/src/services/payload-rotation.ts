import type { DatabaseHandle } from '@flowdular/database';
import type { WorkflowPayloadCodec } from './payload-codec.ts';

/** Payloads re-sealed inside one tenant-scoped transaction. */
export const PAYLOAD_ROTATION_BATCH = 200;

export const PAYLOAD_ROTATION_TABLE = 'workflow_payloads';

export interface PayloadKeyCount {
	readonly keyId: string;
	readonly rows: number;
}

export interface PayloadRotationReport {
	readonly table: string;
	/** Key id every payload should end on: the current key of the codec. */
	readonly currentKeyId: string;
	readonly counts: readonly PayloadKeyCount[];
	/** Payloads on a retired key when the run started. */
	readonly stale: number;
	readonly tenants: number;
	readonly rotated: number;
	/** Payloads a concurrent write changed between the read and the update. */
	readonly skipped: number;
}

export interface PayloadRotationOptions {
	/** Tenant-scoped handle. Every read and write of a payload runs on it. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant handle. It is granted the key ids and nothing else. */
	readonly background: DatabaseHandle;
	readonly codec: WorkflowPayloadCodec;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

interface StaleRow {
	id: string;
	run_id: string;
	ciphertext: string;
}

/* Evidence rows hold a redacted preview and no ciphertext, so only execution
   payloads carry an envelope a key can open. */
const SQL = {
	counts: `SELECT encryption_key_id AS key_id, count(*) AS row_count
	         FROM workflow_payloads
	         WHERE kind = 'execution'
	         GROUP BY encryption_key_id
	         ORDER BY encryption_key_id`,
	staleTenants: `SELECT tenant_id, count(*) AS row_count
	               FROM workflow_payloads
	               WHERE kind = 'execution' AND encryption_key_id IS DISTINCT FROM $1
	               GROUP BY tenant_id
	               ORDER BY tenant_id`,
	/* Paged by primary key: a payload the optimistic update skipped stays stale,
	   so a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT id, run_id, ciphertext
	             FROM workflow_payloads
	             WHERE tenant_id = $1 AND kind = 'execution'
	               AND encryption_key_id IS DISTINCT FROM $2 AND id > $3
	             ORDER BY id
	             LIMIT $4`,
	/* The envelope the row still holds is the optimistic check. A payload is
	   written once and expired later, so a mismatch means retention or a
	   concurrent rotation reached it first. */
	reseal: `UPDATE workflow_payloads
	         SET ciphertext = $1, encryption_key_id = $2
	         WHERE tenant_id = $3 AND id = $4 AND ciphertext = $5`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The workflows database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every stored execution payload that is not on the current key. The
 * inventory is read once across tenants, and each batch of payloads is read,
 * decrypted, re-sealed and written inside one transaction scoped to the tenant
 * that owns them. It is idempotent: a second run finds nothing to do.
 */
export async function rotateWorkflowPayloads(
	options: PayloadRotationOptions,
): Promise<PayloadRotationReport> {
	const currentKeyId = options.codec.keyId;
	const batchSize = options.batchSize ?? PAYLOAD_ROTATION_BATCH;
	const inventory = await options.background.transaction(
		async (transaction) => ({
			counts: (
				await transaction.query<{
					key_id: string | null;
					row_count: number | bigint | string;
				}>({ text: SQL.counts })
			).rows,
			stale: (
				await transaction.query<{
					tenant_id: string;
					row_count: number | bigint | string;
				}>({ text: SQL.staleTenants, parameters: [currentKeyId] })
			).rows,
		}),
		{ access: 'read' },
	);
	const report = {
		table: PAYLOAD_ROTATION_TABLE,
		currentKeyId,
		counts: inventory.counts.map((row) => ({
			keyId: row.key_id ?? 'none',
			rows: count(row.row_count),
		})),
		stale: inventory.stale.reduce(
			(total, row) => total + count(row.row_count),
			0,
		),
		tenants: inventory.stale.length,
	};
	if (options.apply !== true) {
		return { ...report, rotated: 0, skipped: 0 };
	}
	let rotated = 0;
	let skipped = 0;
	for (const { tenant_id: tenantId } of inventory.stale) {
		let cursor = '';
		for (;;) {
			const batch = await options.runtime.transaction(
				async (transaction) => {
					const rows = (
						await transaction.query<StaleRow>({
							text: SQL.staleBatch,
							parameters: [tenantId, currentKeyId, cursor, batchSize],
						})
					).rows;
					let written = 0;
					for (const row of rows) {
						const context = {
							tenantId,
							runId: row.run_id,
							payloadId: row.id,
						};
						const sealed = options.codec.encrypt(
							options.codec.decrypt(row.ciphertext, context),
							context,
						);
						const result = await transaction.execute({
							text: SQL.reseal,
							parameters: [
								sealed,
								options.codec.keyId,
								tenantId,
								row.id,
								row.ciphertext,
							],
						});
						written += result.affectedRows;
					}
					return { read: rows.length, written, last: rows.at(-1)?.id };
				},
				{ access: 'write', tenantId },
			);
			rotated += batch.written;
			skipped += batch.read - batch.written;
			if (batch.read < batchSize || batch.last === undefined) break;
			cursor = batch.last;
		}
	}
	return { ...report, rotated, skipped };
}
