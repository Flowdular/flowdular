import type { DatabaseHandle } from '@flowdular/database';
import { KeyringError } from '@flowdular/kernel';
import { credentialContext, type CredentialVault } from './credential-vault.ts';

/** Rows re-sealed inside one tenant-scoped transaction. */
export const CREDENTIAL_ROTATION_BATCH = 200;

export const CREDENTIAL_ROTATION_TABLE = 'connectors_instances';

export interface CredentialKeyCount {
	readonly keyId: string;
	readonly rows: number;
}

export interface CredentialRotationReport {
	readonly table: string;
	/** Key id every row should end on: the current key of the vault. */
	readonly currentKeyId: string;
	readonly counts: readonly CredentialKeyCount[];
	/** Rows on a retired key when the run started. */
	readonly stale: number;
	readonly tenants: number;
	readonly rotated: number;
	/** Rows a concurrent write changed between the read and the update. */
	readonly skipped: number;
	/** Rows sealed under a key id the vault does not hold; left as they are. */
	readonly unknown: number;
	/** Rows that failed authentication under the key they name; left as they are. */
	readonly refused: number;
}

export interface CredentialRotationOptions {
	/** Tenant-scoped handle. Every read and write of a row runs on it. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant handle. It is granted the key ids and nothing else. */
	readonly background: DatabaseHandle;
	readonly vault: CredentialVault;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

interface StaleRow {
	id: string;
	credential_key_id: string;
	credential_iv: string;
	credential_tag: string;
	credential_ciphertext: string;
}

/* Rows with auth_kind none hold no envelope and no key id, so every statement
   here excludes them by the key id column. */
const SQL = {
	counts: `SELECT credential_key_id AS key_id, count(*) AS row_count
	         FROM connectors_instances
	         WHERE credential_key_id IS NOT NULL
	         GROUP BY credential_key_id
	         ORDER BY credential_key_id`,
	/* The key ids the vault holds are bound as one comma-separated parameter
	   (an id is a hex digest), so a row under a key it does not hold is neither
	   stale nor walked: it is counted and left. */
	staleTenants: `SELECT tenant_id, count(*) AS row_count
	               FROM connectors_instances
	               WHERE credential_key_id IS NOT NULL
	                 AND credential_key_id <> $1
	                 AND credential_key_id = ANY(string_to_array($2, ','))
	               GROUP BY tenant_id
	               ORDER BY tenant_id`,
	/* Paged by primary key: a row the optimistic update skipped stays stale, so
	   a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT id, credential_key_id, credential_iv, credential_tag,
	                    credential_ciphertext
	             FROM connectors_instances
	             WHERE tenant_id = $1 AND credential_key_id IS NOT NULL
	               AND credential_key_id <> $2
	               AND credential_key_id = ANY(string_to_array($3, ',')) AND id > $4
	             ORDER BY id
	             LIMIT $5`,
	/* The envelope the row still holds is the optimistic check: a credential
	   replaced by an owner in between keeps its own value. updated_at marks
	   changes an owner can see, and a re-seal is not one. */
	reseal: `UPDATE connectors_instances
	         SET credential_key_id = $1, credential_iv = $2, credential_tag = $3,
	             credential_ciphertext = $4, credential_fingerprint = $5
	         WHERE tenant_id = $6 AND id = $7 AND credential_ciphertext = $8`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The connectors database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every stored connector credential that is not on the current key.
 * The inventory is read once across tenants, and each batch of rows is read,
 * decrypted, re-sealed and written inside one transaction scoped to the tenant
 * that owns them. The fingerprint is keyed by the current key, so it is
 * recomputed while the plaintext is in hand: the value an owner compares
 * changes with the key, the credential does not. It is idempotent: a second
 * run finds nothing to do.
 */
export async function rotateConnectorCredentials(
	options: CredentialRotationOptions,
): Promise<CredentialRotationReport> {
	const currentKeyId = options.vault.keyId;
	const batchSize = options.batchSize ?? CREDENTIAL_ROTATION_BATCH;
	const counts = await options.background.transaction(
		async (transaction) =>
			(
				await transaction.query<{
					key_id: string;
					row_count: number | bigint | string;
				}>({ text: SQL.counts })
			).rows.map((row) => ({ keyId: row.key_id, rows: count(row.row_count) })),
		{ access: 'read' },
	);
	const known = counts
		.map((entry) => entry.keyId)
		.filter((keyId) => options.vault.knows(keyId))
		.join(',');
	const unknown = counts
		.filter((entry) => !options.vault.knows(entry.keyId))
		.reduce((total, entry) => total + entry.rows, 0);
	const inventory = await options.background.transaction(
		async (transaction) =>
			(
				await transaction.query<{
					tenant_id: string;
					row_count: number | bigint | string;
				}>({ text: SQL.staleTenants, parameters: [currentKeyId, known] })
			).rows,
		{ access: 'read' },
	);
	const report = {
		table: CREDENTIAL_ROTATION_TABLE,
		currentKeyId,
		counts,
		stale: inventory.reduce((total, row) => total + count(row.row_count), 0),
		tenants: inventory.length,
		unknown,
	};
	if (options.apply !== true) {
		return { ...report, rotated: 0, skipped: 0, refused: 0 };
	}
	let rotated = 0;
	let skipped = 0;
	let refused = 0;
	for (const { tenant_id: tenantId } of inventory) {
		let cursor = '';
		for (;;) {
			const batch = await options.runtime.transaction(
				async (transaction) => {
					const rows = (
						await transaction.query<StaleRow>({
							text: SQL.staleBatch,
							parameters: [tenantId, currentKeyId, known, cursor, batchSize],
						})
					).rows;
					let written = 0;
					let left = 0;
					for (const row of rows) {
						const context = credentialContext(tenantId, row.id);
						let plaintext: string;
						try {
							plaintext = options.vault.open(
								{
									keyId: row.credential_key_id,
									iv: row.credential_iv,
									tag: row.credential_tag,
									ciphertext: row.credential_ciphertext,
								},
								context,
							);
						} catch (error) {
							/* A tag that fails under the key it names is evidence the pass
							   must not replace with a fresh envelope; the row stays. */
							if (
								error instanceof KeyringError &&
								error.code === 'ENVELOPE_INVALID'
							) {
								left += 1;
								continue;
							}
							throw error;
						}
						const sealed = options.vault.seal(plaintext, context);
						const result = await transaction.execute({
							text: SQL.reseal,
							parameters: [
								sealed.keyId,
								sealed.iv,
								sealed.tag,
								sealed.ciphertext,
								options.vault.fingerprint(plaintext, context),
								tenantId,
								row.id,
								row.credential_ciphertext,
							],
						});
						written += result.affectedRows;
					}
					return {
						read: rows.length,
						written,
						left,
						last: rows.at(-1)?.id,
					};
				},
				{ access: 'write', tenantId },
			);
			rotated += batch.written;
			refused += batch.left;
			skipped += batch.read - batch.left - batch.written;
			if (batch.read < batchSize || batch.last === undefined) break;
			cursor = batch.last;
		}
	}
	return { ...report, rotated, skipped, refused };
}
