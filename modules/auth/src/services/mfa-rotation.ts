import type { DatabaseHandle } from '@flowdular/database';
import { IDENTITY_TENANT_CONTEXT } from './database-repository.ts';
import type { MfaSecretVault } from './totp.ts';

/** Rows re-sealed inside one transaction. */
export const MFA_ROTATION_BATCH = 200;

export const MFA_ROTATION_TABLE = 'auth_mfa_totp';

export interface MfaKeyCount {
	/** Null for a row sealed before 0017 recorded which key wrote it. */
	readonly keyId: string | null;
	readonly rows: number;
}

export interface MfaRotationReport {
	readonly table: string;
	/** Key id every row should end on: the current key of the vault. */
	readonly currentKeyId: string;
	readonly counts: readonly MfaKeyCount[];
	/** Rows on a retired key, or on none at all, when the run started. */
	readonly stale: number;
	readonly rotated: number;
	/** Rows a concurrent enrolment rewrote between the read and the update. */
	readonly skipped: number;
}

export interface MfaRotationOptions {
	/**
	 * The runtime handle the auth repository uses. An enrolled factor belongs to
	 * the account rather than to a workspace, so the table carries no tenant
	 * column and no row-security policy, and every statement here runs under the
	 * same identity context the repository reads and writes it under.
	 */
	readonly database: DatabaseHandle;
	readonly vault: MfaSecretVault;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

interface StaleRow {
	account_id: string;
	secret_ciphertext: string;
	key_id: string | null;
}

const SQL = {
	counts: `SELECT key_id, count(*) AS row_count
	         FROM auth_mfa_totp
	         GROUP BY key_id
	         ORDER BY key_id`,
	/* Paged by primary key: a row the optimistic update skipped stays stale, so
	   a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT account_id, secret_ciphertext, key_id
	             FROM auth_mfa_totp
	             WHERE key_id IS DISTINCT FROM $1 AND account_id > $2
	             ORDER BY account_id
	             LIMIT $3`,
	/* The envelope the row still holds is the optimistic check: a factor the
	   account re-enrolled in between keeps its own secret. Nothing outside the
	   envelope columns changes, so a re-seal is not an enrolment. */
	reseal: `UPDATE auth_mfa_totp SET secret_ciphertext = $1, key_id = $2
	         WHERE account_id = $3 AND secret_ciphertext = $4`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The auth database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every stored TOTP secret that is not on the current key, including
 * the rows that predate the key id column. The inventory is read once and each
 * batch is read, opened, re-sealed and written inside one transaction. It is
 * idempotent: a second run finds nothing to do.
 */
export async function rotateMfaSecrets(
	options: MfaRotationOptions,
): Promise<MfaRotationReport> {
	const currentKeyId = options.vault.keyId;
	const batchSize = options.batchSize ?? MFA_ROTATION_BATCH;
	const inventory = await options.database.transaction(
		async (transaction) =>
			(
				await transaction.query<{
					key_id: string | null;
					row_count: number | bigint | string;
				}>({ text: SQL.counts })
			).rows,
		{ access: 'read', tenantId: IDENTITY_TENANT_CONTEXT },
	);
	const counts = inventory.map((row) => ({
		keyId: row.key_id,
		rows: count(row.row_count),
	}));
	const stale = counts.reduce(
		(total, entry) =>
			entry.keyId === currentKeyId ? total : total + entry.rows,
		0,
	);
	const report = { table: MFA_ROTATION_TABLE, currentKeyId, counts, stale };
	if (options.apply !== true) return { ...report, rotated: 0, skipped: 0 };
	let rotated = 0;
	let skipped = 0;
	let cursor = '';
	for (;;) {
		const batch = await options.database.transaction(
			async (transaction) => {
				const rows = (
					await transaction.query<StaleRow>({
						text: SQL.staleBatch,
						parameters: [currentKeyId, cursor, batchSize],
					})
				).rows;
				let written = 0;
				for (const row of rows) {
					const sealed = options.vault.seal(
						options.vault.open(row.secret_ciphertext, row.key_id),
					);
					const result = await transaction.execute({
						text: SQL.reseal,
						parameters: [
							sealed.ciphertext,
							sealed.keyId,
							row.account_id,
							row.secret_ciphertext,
						],
					});
					written += result.affectedRows;
				}
				return { read: rows.length, written, last: rows.at(-1)?.account_id };
			},
			{ access: 'write', tenantId: IDENTITY_TENANT_CONTEXT },
		);
		rotated += batch.written;
		skipped += batch.read - batch.written;
		if (batch.read < batchSize || batch.last === undefined) break;
		cursor = batch.last;
	}
	return { ...report, rotated, skipped };
}
