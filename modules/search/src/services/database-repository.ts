import type { DatabaseHandle } from '@flowdular/database';
import { integer, runDatabaseMigrations } from '@flowdular/database';
import type { RecentQuery } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ExportedRecentQuery,
	RecordQueryInput,
	SearchRepository,
} from './repository.ts';

interface RecentQueryRow {
	id: string;
	account_id: string;
	query: string;
	ran_at: number | bigint | string;
}

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const RECORD = `INSERT INTO search_recent_queries
			 (id, tenant_id, account_id, query, ran_at)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (tenant_id, account_id, lower(query))
			 DO UPDATE SET query = EXCLUDED.query, ran_at = EXCLUDED.ran_at`;

/* The bound is enforced where the row is written, so the list endpoint never
   has to clean up on read and the table cannot grow past 50 per member. */
const TRIM = `DELETE FROM search_recent_queries
			 WHERE tenant_id = $1 AND account_id = $2 AND id NOT IN (
			   SELECT id FROM search_recent_queries
			   WHERE tenant_id = $1 AND account_id = $2
			   ORDER BY ran_at DESC, id DESC
			   LIMIT $3
			 )`;

const LIST = `SELECT id, account_id, query, ran_at
			 FROM search_recent_queries
			 WHERE tenant_id = $1 AND account_id = $2
			 ORDER BY ran_at DESC, id DESC
			 LIMIT $3`;

const CLEAR = `DELETE FROM search_recent_queries
			 WHERE tenant_id = $1 AND account_id = $2`;

const SWEEP = `DELETE FROM search_recent_queries
			 WHERE tenant_id = $1 AND id IN (
			   SELECT id FROM search_recent_queries
			   WHERE tenant_id = $1 AND ran_at < $2
			   ORDER BY ran_at, id
			   LIMIT $3
			 )`;

/* The export walks the immutable key: re-running a query rewrites ran_at, and
   a keyset on it would hand the walk the same row again on a later page. */
const EXPORT = `SELECT id, account_id, query, ran_at
			 FROM search_recent_queries
			 WHERE tenant_id = $1 AND id > $2
			 ORDER BY id
			 LIMIT $3`;

function fromRow(row: RecentQueryRow): RecentQuery {
	return { query: row.query, ranAt: integer(row.ran_at, 'ran_at', { min: 0 }) };
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseSearchRepository implements SearchRepository {
	constructor(private readonly database: DatabaseHandle) {}

	async recordQuery(input: RecordQueryInput): Promise<void> {
		/* Write and trim share one transaction: a member never sees 51 rows, and
		   a failed trim never leaves the insert behind. */
		await this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: RECORD,
					parameters: [
						input.id,
						input.tenantId,
						input.accountId,
						input.query,
						input.ranAt,
					],
				});
				await transaction.execute({
					text: TRIM,
					parameters: [input.tenantId, input.accountId, input.keep],
				});
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	async listRecent(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<readonly RecentQuery[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<RecentQueryRow>({
					text: LIST,
					parameters: [tenantId, accountId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async clearRecent(tenantId: string, accountId: string): Promise<number> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: CLEAR,
					parameters: [tenantId, accountId],
				}),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async sweepRecent(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SWEEP,
					parameters: [tenantId, cutoff, limit],
				}),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async exportRecent(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly (ExportedRecentQuery & { readonly id: string })[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<RecentQueryRow>({
					text: EXPORT,
					parameters: [tenantId, afterId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => ({
			id: row.id,
			accountId: row.account_id,
			query: row.query,
			ranAt: integer(row.ran_at, 'ran_at', { min: 0 }),
		}));
	}
}

export async function migrateSearchDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'search.core', databaseMigrations);
}
