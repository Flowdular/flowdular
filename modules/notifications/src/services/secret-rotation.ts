import type { DatabaseHandle } from '@flowdular/database';
import { secretContext, type SecretVault } from './secret-vault.ts';

/** Rows re-sealed inside one tenant-scoped transaction. */
export const SECRET_ROTATION_BATCH = 200;

export const SECRET_ROTATION_TABLE = 'notifications_webhook_subscriptions';

export interface SecretKeyCount {
	readonly keyId: string;
	readonly rows: number;
}

export interface SecretRotationReport {
	readonly table: string;
	/** Key id every row should end on: the current key of the vault. */
	readonly currentKeyId: string;
	readonly counts: readonly SecretKeyCount[];
	/** Rows on a retired key when the run started. */
	readonly stale: number;
	readonly tenants: number;
	readonly rotated: number;
	/** Rows a concurrent write changed between the read and the update. */
	readonly skipped: number;
}

export interface SecretRotationOptions {
	/** Tenant-scoped handle. Every read and write of a row runs on it. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant handle. It is granted the key ids and nothing else. */
	readonly background: DatabaseHandle;
	readonly vault: SecretVault;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

interface StaleRow {
	id: string;
	secret_key_id: string;
	secret_iv: string;
	secret_tag: string;
	secret_ciphertext: string;
}

const SQL = {
	counts: `SELECT secret_key_id AS key_id, count(*) AS row_count
	         FROM notifications_webhook_subscriptions
	         GROUP BY secret_key_id
	         ORDER BY secret_key_id`,
	staleTenants: `SELECT tenant_id, count(*) AS row_count
	               FROM notifications_webhook_subscriptions
	               WHERE secret_key_id <> $1
	               GROUP BY tenant_id
	               ORDER BY tenant_id`,
	/* Paged by primary key: a row the optimistic update skipped stays stale, so
	   a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT id, secret_key_id, secret_iv, secret_tag, secret_ciphertext
	             FROM notifications_webhook_subscriptions
	             WHERE tenant_id = $1 AND secret_key_id <> $2 AND id > $3
	             ORDER BY id
	             LIMIT $4`,
	/* The envelope the row still holds is the optimistic check: a secret rotated
	   by the application in between keeps its own value. secret_revision counts
	   secret changes a caller can see, and a re-seal is not one, so neither it
	   nor the fingerprint moves here. */
	reseal: `UPDATE notifications_webhook_subscriptions
	         SET secret_key_id = $1, secret_iv = $2, secret_tag = $3,
	             secret_ciphertext = $4
	         WHERE tenant_id = $5 AND id = $6 AND secret_ciphertext = $7`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The notifications database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every stored webhook signing secret that is not on the current key.
 * The inventory is read once across tenants, and each batch of rows is read,
 * decrypted, re-sealed and written inside one transaction scoped to the tenant
 * that owns them. It is idempotent: a second run finds nothing to do.
 */
export async function rotateWebhookSecrets(
	options: SecretRotationOptions,
): Promise<SecretRotationReport> {
	const currentKeyId = options.vault.keyId;
	const batchSize = options.batchSize ?? SECRET_ROTATION_BATCH;
	const inventory = await options.background.transaction(
		async (transaction) => ({
			counts: (
				await transaction.query<{
					key_id: string;
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
		table: SECRET_ROTATION_TABLE,
		currentKeyId,
		counts: inventory.counts.map((row) => ({
			keyId: row.key_id,
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
						const context = secretContext(tenantId, row.id);
						const sealed = options.vault.encrypt(
							options.vault.decrypt(
								{
									keyId: row.secret_key_id,
									iv: row.secret_iv,
									tag: row.secret_tag,
									ciphertext: row.secret_ciphertext,
								},
								context,
							),
							context,
						);
						const result = await transaction.execute({
							text: SQL.reseal,
							parameters: [
								sealed.keyId,
								sealed.iv,
								sealed.tag,
								sealed.ciphertext,
								tenantId,
								row.id,
								row.secret_ciphertext,
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
