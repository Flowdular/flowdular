import type { DatabaseHandle } from '@flowdular/database';
import type { AgentProviderKind } from '../domain/types.ts';
import { credentialContext, type CredentialVault } from './credential-vault.ts';

/** Rows re-sealed inside one tenant-scoped transaction. */
export const CREDENTIAL_ROTATION_BATCH = 200;

export const CREDENTIAL_ROTATION_TABLE = 'agent_provider_connections';

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
	kind: AgentProviderKind;
	credential_key_id: string;
	credential_iv: string;
	credential_tag: string;
	credential_ciphertext: string;
}

const SQL = {
	counts: `SELECT credential_key_id AS key_id, count(*) AS row_count
	         FROM agent_provider_connections
	         GROUP BY credential_key_id
	         ORDER BY credential_key_id`,
	staleTenants: `SELECT tenant_id, count(*) AS row_count
	               FROM agent_provider_connections
	               WHERE credential_key_id <> $1
	               GROUP BY tenant_id
	               ORDER BY tenant_id`,
	/* Paged by primary key: a row the optimistic update skipped stays stale, so
	   a query that only asked for stale rows would return it forever. */
	staleBatch: `SELECT id, kind, credential_key_id, credential_iv,
	                    credential_tag, credential_ciphertext
	             FROM agent_provider_connections
	             WHERE tenant_id = $1 AND credential_key_id <> $2 AND id > $3
	             ORDER BY id
	             LIMIT $4`,
	/* The envelope the row still holds is the optimistic check: a credential
	   rewritten by the application in between keeps its own value. Nothing
	   outside the envelope columns changes, so a re-seal is not an edit. */
	reseal: `UPDATE agent_provider_connections
	         SET credential_key_id = $1, credential_iv = $2,
	             credential_tag = $3, credential_ciphertext = $4
	         WHERE tenant_id = $5 AND id = $6 AND credential_ciphertext = $7`,
};

function count(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The agents database returned an invalid count.');
	}
	return normalized;
}

/**
 * Re-seals every stored provider credential that is not on the current key.
 * The inventory is read once across tenants, and each batch of rows is read,
 * decrypted, re-sealed and written inside one transaction scoped to the tenant
 * that owns them. It is idempotent: a second run finds nothing to do.
 */
export async function rotateProviderCredentials(
	options: CredentialRotationOptions,
): Promise<CredentialRotationReport> {
	const currentKeyId = options.vault.keyId;
	const batchSize = options.batchSize ?? CREDENTIAL_ROTATION_BATCH;
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
	const counts = inventory.counts.map((row) => ({
		keyId: row.key_id,
		rows: count(row.row_count),
	}));
	const stale = inventory.stale.reduce(
		(total, row) => total + count(row.row_count),
		0,
	);
	const report = {
		table: CREDENTIAL_ROTATION_TABLE,
		currentKeyId,
		counts,
		stale,
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
						const context = credentialContext({
							tenantId,
							id: row.id,
							kind: row.kind,
						});
						const sealed = options.vault.encrypt(
							options.vault.decrypt(
								{
									keyId: row.credential_key_id,
									iv: row.credential_iv,
									tag: row.credential_tag,
									ciphertext: row.credential_ciphertext,
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
								row.credential_ciphertext,
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
