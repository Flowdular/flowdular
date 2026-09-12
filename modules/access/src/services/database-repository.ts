import type { DatabaseHandle } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { keysetWhere } from '@flowdular/server';
import type {
	AccessAttestation,
	AttestationPosition,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { AccessRepository, AttestationQuery } from './repository.ts';

interface AttestationRow {
	id: string;
	tenant_id: string;
	reviewer_account_id: string;
	reviewer_label: string;
	period_from: Date | string;
	period_to: Date | string;
	member_count: number | bigint | string;
	active_member_count: number | bigint | string;
	role_count: number | bigint | string;
	extra_scope_count: number | bigint | string;
	token_count: number | bigint | string;
	provider_count: number | bigint | string;
	note: string | null;
	created_at: number | bigint | string;
}

const COLUMNS = `id, tenant_id, reviewer_account_id, reviewer_label,
	 period_from, period_to, member_count, active_member_count, role_count,
	 extra_scope_count, token_count, provider_count, note, created_at`;

/* The page order and the keyset predicate are one decision: both columns run
   descending, which is the order access_attestations_tenant_created_idx
   carries. The export walks the same index backwards, oldest first. */
const PAGE_KEYSET = keysetWhere(['created_at', 'id'], ['', ''], {
	direction: 'desc',
	parameterOffset: 1,
}).text;

const EXPORT_KEYSET = keysetWhere(['created_at', 'id'], ['', ''], {
	direction: 'asc',
	parameterOffset: 1,
}).text;

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. There is no
   update and no delete: the ledger only grows. */
const SQL = {
	append: `INSERT INTO access_attestations (${COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
	list: `SELECT ${COLUMNS} FROM access_attestations
	 WHERE tenant_id = $1
	 ORDER BY created_at DESC, id DESC
	 LIMIT $2`,
	listPage: `SELECT ${COLUMNS} FROM access_attestations
	 WHERE tenant_id = $1 AND ${PAGE_KEYSET}
	 ORDER BY created_at DESC, id DESC
	 LIMIT $4`,
	exportFirst: `SELECT ${COLUMNS} FROM access_attestations
	 WHERE tenant_id = $1
	 ORDER BY created_at, id
	 LIMIT $2`,
	exportPage: `SELECT ${COLUMNS} FROM access_attestations
	 WHERE tenant_id = $1 AND ${EXPORT_KEYSET}
	 ORDER BY created_at, id
	 LIMIT $4`,
} as const;

/* PostgreSQL returns BIGINT as a string, so every numeric read is normalized
   before it reaches the domain. */
function whole(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error(`The access database returned an invalid ${field}.`);
	}
	return normalized;
}

/* The driver returns a timestamp as a Date; the domain keeps ISO text. */
function isoText(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

function fromRow(row: AttestationRow): AccessAttestation {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		reviewerAccountId: row.reviewer_account_id,
		reviewerLabel: row.reviewer_label,
		periodFrom: isoText(row.period_from),
		periodTo: isoText(row.period_to),
		memberCount: whole(row.member_count, 'member count'),
		activeMemberCount: whole(row.active_member_count, 'member count'),
		roleCount: whole(row.role_count, 'role count'),
		extraScopeCount: whole(row.extra_scope_count, 'scope count'),
		tokenCount: whole(row.token_count, 'token count'),
		providerCount: whole(row.provider_count, 'provider count'),
		note: row.note,
		createdAt: whole(row.created_at, 'timestamp'),
	};
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseAccessRepository implements AccessRepository {
	constructor(private readonly database: DatabaseHandle) {}

	async append(record: AccessAttestation): Promise<AccessAttestation> {
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.append,
					parameters: [
						record.id,
						record.tenantId,
						record.reviewerAccountId,
						record.reviewerLabel,
						record.periodFrom,
						record.periodTo,
						record.memberCount,
						record.activeMemberCount,
						record.roleCount,
						record.extraScopeCount,
						record.tokenCount,
						record.providerCount,
						record.note,
						record.createdAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return record;
	}

	async list(
		tenantId: string,
		query: AttestationQuery,
	): Promise<readonly AccessAttestation[]> {
		const result = await this.database.transaction(
			(transaction) =>
				query.after === null
					? transaction.query<AttestationRow>({
							text: SQL.list,
							parameters: [tenantId, query.limit],
						})
					: transaction.query<AttestationRow>({
							text: SQL.listPage,
							parameters: [
								tenantId,
								query.after.createdAt,
								query.after.id,
								query.limit,
							],
						}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async exportPage(
		tenantId: string,
		after: AttestationPosition | null,
		limit: number,
	): Promise<readonly AccessAttestation[]> {
		const result = await this.database.transaction(
			(transaction) =>
				after === null
					? transaction.query<AttestationRow>({
							text: SQL.exportFirst,
							parameters: [tenantId, limit],
						})
					: transaction.query<AttestationRow>({
							text: SQL.exportPage,
							parameters: [tenantId, after.createdAt, after.id, limit],
						}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}
}

export async function migrateAccessDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'access.core', databaseMigrations);
}
