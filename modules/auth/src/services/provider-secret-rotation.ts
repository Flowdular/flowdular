import type { DatabaseHandle } from '@flowdular/database';
import type { ProviderSecretVault } from './provider-secrets.ts';

/** Rows re-sealed inside one transaction, per workspace. */
export const PROVIDER_ROTATION_BATCH = 200;

export const PROVIDER_ROTATION_TABLE = 'auth_identity_providers';

export interface ProviderKeyCount {
	readonly keyId: string;
	readonly rows: number;
}

export interface ProviderRotationReport {
	readonly table: string;
	/** Key id every row should end on: the current key of the vault. */
	readonly currentKeyId: string;
	readonly counts: readonly ProviderKeyCount[];
	/** Rows on a retired key when the run started. */
	readonly stale: number;
	readonly rotated: number;
	/** Rows an administrator rewrote between the read and the update. */
	readonly skipped: number;
}

export interface ProviderRotationOptions {
	/**
	 * The tenant-scoped runtime handle. A provider row is workspace data under a
	 * forced policy, so every statement runs under the workspace that owns it and
	 * the run walks the workspaces one at a time.
	 */
	readonly database: DatabaseHandle;
	/** The workspaces to walk; the caller reads them on the routing handle. */
	readonly tenants: () => Promise<readonly string[]>;
	readonly vault: ProviderSecretVault;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

interface StaleRow {
	id: string;
	client_secret_ciphertext: string;
	client_secret_key_id: string;
}

const SQL = {
	counts: `SELECT client_secret_key_id, count(*) AS row_count
	         FROM auth_identity_providers
	         WHERE tenant_id = $1
	         GROUP BY client_secret_key_id`,
	/* Paged by primary key: a row the optimistic update skipped stays stale, so
	   a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT id, client_secret_ciphertext, client_secret_key_id
	             FROM auth_identity_providers
	             WHERE tenant_id = $1 AND client_secret_key_id IS DISTINCT FROM $2
	               AND id > $3
	             ORDER BY id
	             LIMIT $4`,
	/* The envelope the row still holds is the optimistic check: a secret an
	   administrator rotated in between keeps its own envelope, and the
	   fingerprint is left alone because the secret behind it did not change. */
	reseal: `UPDATE auth_identity_providers
	         SET client_secret_ciphertext = $1, client_secret_key_id = $2
	         WHERE tenant_id = $3 AND id = $4 AND client_secret_ciphertext = $5`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The auth database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every tenant-owned provider secret that is not on the current key.
 * The inventory is read once per workspace and each batch is read, opened,
 * re-sealed and written inside one transaction. It is idempotent: a second run
 * finds nothing to do, and a sign-in keeps working throughout because the
 * retired key stays on the ring until the operator drops it.
 */
export async function rotateProviderSecrets(
	options: ProviderRotationOptions,
): Promise<ProviderRotationReport> {
	const currentKeyId = options.vault.keyId;
	const batchSize = options.batchSize ?? PROVIDER_ROTATION_BATCH;
	const tenants = await options.tenants();
	const totals = new Map<string, number>();
	for (const tenantId of tenants) {
		const rows = await options.database.transaction(
			async (transaction) =>
				(
					await transaction.query<{
						client_secret_key_id: string;
						row_count: number | bigint | string;
					}>({ text: SQL.counts, parameters: [tenantId] })
				).rows,
			{ access: 'read', tenantId },
		);
		for (const row of rows) {
			totals.set(
				row.client_secret_key_id,
				(totals.get(row.client_secret_key_id) ?? 0) + count(row.row_count),
			);
		}
	}
	const counts = [...totals]
		.map(([keyId, rows]) => ({ keyId, rows }))
		.sort((left, right) => left.keyId.localeCompare(right.keyId));
	const stale = counts.reduce(
		(total, entry) =>
			entry.keyId === currentKeyId ? total : total + entry.rows,
		0,
	);
	const report = {
		table: PROVIDER_ROTATION_TABLE,
		currentKeyId,
		counts,
		stale,
	};
	if (options.apply !== true) return { ...report, rotated: 0, skipped: 0 };
	let rotated = 0;
	let skipped = 0;
	for (const tenantId of tenants) {
		let cursor = '';
		for (;;) {
			const batch = await options.database.transaction(
				async (transaction) => {
					const rows = (
						await transaction.query<StaleRow>({
							text: SQL.staleBatch,
							parameters: [tenantId, currentKeyId, cursor, batchSize],
						})
					).rows;
					let written = 0;
					for (const row of rows) {
						const context = { tenantId, providerId: row.id };
						const sealed = options.vault.seal(
							context,
							options.vault.open(
								context,
								row.client_secret_ciphertext,
								row.client_secret_key_id,
							),
						);
						const result = await transaction.execute({
							text: SQL.reseal,
							parameters: [
								sealed.ciphertext,
								sealed.keyId,
								tenantId,
								row.id,
								row.client_secret_ciphertext,
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
