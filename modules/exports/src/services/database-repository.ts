import type { DatabaseHandle } from '@flowdular/database';
import { integer, runDatabaseMigrations } from '@flowdular/database';
import type {
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type {
	ClaimedExportJob,
	ExportJob,
	ExportJobRouting,
	ExportJobStatus,
	ExportRequester,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ClaimExportJobInput,
	ExportJobPage,
	ExportJobQuery,
	ExportRepository,
	ExportSweepBatch,
	ExportSweepInput,
	SettleExportJobInput,
} from './repository.ts';

const JOB_COLUMNS = `id, tenant_id, list_id, status, row_count, byte_count,
	object_id, requester_account_id, requester_json, failure_code, claimed_at,
	started_at, completed_at`;

/* Queries stay explicit and every value travels through the parameter channel;
   no export data is ever concatenated into SQL. */
const SQL = {
	insertJob: `INSERT INTO exports_jobs (${JOB_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,

	findJob: `SELECT ${JOB_COLUMNS} FROM exports_jobs
	 WHERE tenant_id = $1 AND id = $2`,

	/* Read through the cross-tenant background lease, which is granted these
	   four columns and no others. */
	listPendingJobs: `SELECT tenant_id, id, status, started_at
	 FROM exports_jobs
	 WHERE status IN ('requested', 'running')
	 ORDER BY started_at, tenant_id, id
	 LIMIT $1`,

	/* One statement, so two platform processes cannot both take one job. A
	   claim older than the lease belonged to a process that is gone. */
	claimJob: `UPDATE exports_jobs SET status = 'running', claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2
	   AND (status = 'requested'
	        OR (status = 'running' AND (claimed_at IS NULL OR claimed_at <= $4)))
	 RETURNING ${JOB_COLUMNS}`,

	/* Renewed by the stage that holds the claim. The claim guard keeps a stage
	   whose lease lapsed from renewing a claim that is now somebody else's. */
	heartbeatJob: `UPDATE exports_jobs SET claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2 AND claimed_at = $4 AND status = 'running'`,

	/* The status transition is the fence. A renewal moves `claimed_at` while the
	   stage runs, so a settle cannot pin the claim it started under without a
	   fencing token of its own; what it can do is settle a job that is still
	   running exactly once. Two processes that both ran the job leave one
	   settled job, and the loser is told so and discards the file it wrote. */
	settleJob: `UPDATE exports_jobs
	 SET status = $3, row_count = $4, byte_count = $5, object_id = $6,
	     failure_code = $7, completed_at = $8, claimed_at = NULL
	 WHERE tenant_id = $1 AND id = $2 AND status = 'running'
	 RETURNING ${JOB_COLUMNS}`,

	/* The batch is chosen once and its objects come back with it: deleting the
	   files and then the rows from one chosen set means no pass can delete a
	   file whose row a differently ordered second query kept. */
	sweepBatch: `SELECT id, object_id FROM exports_jobs
	 WHERE tenant_id = $1 AND started_at < $2
	   AND status IN ('completed', 'failed')
	 ORDER BY started_at, id LIMIT $3`,

	exportPage: `SELECT ${JOB_COLUMNS} FROM exports_jobs
	 WHERE tenant_id = $1 AND (started_at, id) > ($2, $3)
	 ORDER BY started_at, id LIMIT $4`,
} as const;

interface JobRow {
	id: string;
	tenant_id: string;
	list_id: string;
	status: ExportJobStatus;
	row_count: number | bigint | string;
	byte_count: number | bigint | string;
	object_id: string | null;
	requester_account_id: string;
	requester_json: string;
	failure_code: string | null;
	claimed_at: number | bigint | string | null;
	started_at: number | bigint | string;
	completed_at: number | bigint | string | null;
}

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

/* A column written by this module, so a parse failure is corruption rather than
   input; the stable message names the column instead of leaking the payload. */
function requesterOf(raw: string): ExportRequester {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('The export database returned an invalid requester.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('The export database returned an invalid requester.');
	}
	const value = parsed as Partial<ExportRequester>;
	return {
		accountId: String(value.accountId ?? ''),
		email: String(value.email ?? ''),
		displayName: String(value.displayName ?? ''),
		role: String(value.role ?? ''),
		scopes: Array.isArray(value.scopes) ? value.scopes.map(String) : [],
	};
}

function jobFromRow(row: JobRow): ExportJob {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		listId: row.list_id,
		status: row.status,
		rowCount: integer(row.row_count, 'row count'),
		byteCount: integer(row.byte_count, 'byte count'),
		objectId: row.object_id,
		requesterAccountId: row.requester_account_id,
		requester: requesterOf(row.requester_json),
		failureCode: row.failure_code,
		claimedAt: optionalInteger(row.claimed_at, 'timestamp'),
		startedAt: integer(row.started_at, 'timestamp'),
		completedAt: optionalInteger(row.completed_at, 'timestamp'),
	};
}

function jobParameters(job: ExportJob): readonly (string | number | null)[] {
	return [
		job.id,
		job.tenantId,
		job.listId,
		job.status,
		job.rowCount,
		job.byteCount,
		job.objectId,
		job.requesterAccountId,
		JSON.stringify(job.requester),
		job.failureCode,
		job.claimedAt,
		job.startedAt,
		job.completedAt,
	];
}

/** Jobs one page of the data class export walks. */
const EXPORT_PAGE = 500;

export async function migrateExportsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'exports.core', databaseMigrations);
}

export interface ExportDatabaseHandles {
	readonly runtime: DatabaseHandle;
	/** Cross-tenant, read only, granted the job routing columns alone. */
	readonly background: DatabaseHandle;
}

export class DatabaseExportRepository implements ExportRepository {
	readonly #handles: ExportDatabaseHandles;

	constructor(handles: ExportDatabaseHandles) {
		this.#handles = handles;
	}

	async createJob(job: ExportJob): Promise<ExportJob> {
		await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.insertJob,
					parameters: jobParameters(job),
				}),
			{ access: 'write', tenantId: job.tenantId },
		);
		return job;
	}

	async findJob(tenantId: string, id: string): Promise<ExportJob | null> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<JobRow>({
					text: SQL.findJob,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? jobFromRow(row) : null;
	}

	async listJobs(
		tenantId: string,
		query: ExportJobQuery,
	): Promise<ExportJobPage> {
		const parameters: (string | number)[] = [tenantId];
		let text = `SELECT ${JOB_COLUMNS} FROM exports_jobs WHERE tenant_id = $1`;
		if (query.status) {
			parameters.push(query.status);
			text += ` AND status = $${parameters.length}`;
		}
		if (query.cursor) {
			parameters.push(query.cursor.startedAt, query.cursor.id);
			text += ` AND (started_at, id) < ($${parameters.length - 1}, $${parameters.length})`;
		}
		/* One row past the page tells the caller there is another page without a
		   second count over the workspace's jobs. */
		parameters.push(query.limit + 1);
		text += ` ORDER BY started_at DESC, id DESC LIMIT $${parameters.length}`;
		const result = await this.#handles.runtime.transaction(
			(transaction) => transaction.query<JobRow>({ text, parameters }),
			{ access: 'read', tenantId },
		);
		const items = result.rows.slice(0, query.limit).map(jobFromRow);
		const last = items[items.length - 1];
		return {
			items,
			nextCursor:
				result.rows.length > query.limit && last
					? { startedAt: last.startedAt, id: last.id }
					: null,
		};
	}

	async listPendingJobs(limit: number): Promise<readonly ExportJobRouting[]> {
		const result = await this.#handles.background.query<{
			tenant_id: string;
			id: string;
			status: ExportJobStatus;
			started_at: number | bigint | string;
		}>({ text: SQL.listPendingJobs, parameters: [limit] });
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			status: row.status,
			startedAt: integer(row.started_at, 'timestamp'),
		}));
	}

	async claimJob(input: ClaimExportJobInput): Promise<ClaimedExportJob | null> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<JobRow>({
					text: SQL.claimJob,
					parameters: [
						input.tenantId,
						input.id,
						input.claimedAt,
						input.staleBefore,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		if (!row) return null;
		const job = jobFromRow(row);
		return { ...job, claimedAt: input.claimedAt };
	}

	async heartbeatJob(
		tenantId: string,
		id: string,
		at: number,
		claimedAt: number,
	): Promise<boolean> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.heartbeatJob,
					parameters: [tenantId, id, at, claimedAt],
				}),
			{ access: 'write', tenantId },
		);
		return result.affectedRows > 0;
	}

	async settleJob(
		tenantId: string,
		id: string,
		input: SettleExportJobInput,
	): Promise<ExportJob | null> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<JobRow>({
					text: SQL.settleJob,
					parameters: [
						tenantId,
						id,
						input.status,
						input.rowCount,
						input.byteCount,
						input.objectId,
						input.failureCode,
						input.completedAt,
					],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
		return row ? jobFromRow(row) : null;
	}

	async claimSweepBatch(
		tenantId: string,
		input: ExportSweepInput,
	): Promise<ExportSweepBatch> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<{ id: string; object_id: string | null }>({
					text: SQL.sweepBatch,
					parameters: [tenantId, input.settledBefore, input.limit],
				}),
			{ access: 'read', tenantId },
		);
		const ids: string[] = [];
		const objectIds: string[] = [];
		for (const row of result.rows) {
			ids.push(row.id);
			if (row.object_id !== null) objectIds.push(row.object_id);
		}
		return { ids, objectIds };
	}

	async deleteJobs(tenantId: string, ids: readonly string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const parameters: (string | number)[] = [tenantId, ...ids];
		const placeholders = ids.map((_id, index) => `$${index + 2}`).join(', ');
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM exports_jobs WHERE tenant_id = $1 AND id IN (${placeholders})`,
					parameters,
				}),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async exportJobs(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		let rows = 0;
		let from: Date | null = null;
		let to: Date | null = null;
		let cursor: { startedAt: number; id: string } = { startedAt: 0, id: '' };
		for (;;) {
			const found = await this.#handles.runtime.transaction(
				(transaction) =>
					transaction.query<JobRow>({
						text: SQL.exportPage,
						parameters: [tenantId, cursor.startedAt, cursor.id, EXPORT_PAGE],
					}),
				{ access: 'read', tenantId },
			);
			for (const row of found.rows) {
				const record = jobFromRow(row);
				/* The requester snapshot is bookkeeping for a background stage, and
				   the object id addresses bytes this export does not carry, so
				   neither reaches a workspace export. */
				await sink.write({
					record: 'job',
					id: record.id,
					listId: record.listId,
					status: record.status,
					rowCount: record.rowCount,
					byteCount: record.byteCount,
					requesterAccountId: record.requesterAccountId,
					failureCode: record.failureCode,
					startedAt: new Date(record.startedAt).toISOString(),
					completedAt:
						record.completedAt === null
							? null
							: new Date(record.completedAt).toISOString(),
				});
				rows += 1;
				const instant = new Date(record.startedAt);
				if (from === null || instant < from) from = instant;
				if (to === null || instant > to) to = instant;
				cursor = { startedAt: record.startedAt, id: record.id };
			}
			if (found.rows.length < EXPORT_PAGE) break;
		}
		return { rows, from, to };
	}
}
