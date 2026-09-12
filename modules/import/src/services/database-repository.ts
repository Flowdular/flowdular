import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type { DataClassExportSink } from '@flowdular/kernel';
import type { ImportMode } from '../domain/ports.ts';
import {
	type ClaimedImportJob,
	type ImportJob,
	type ImportJobRouting,
	type ImportJobRow,
	type ImportJobStatus,
	type ImportMapping,
	type ImportRequester,
	type ImportRowOutcome,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ClaimJobInput,
	ImportJobPage,
	ImportJobQuery,
	ImportJobResult,
	ImportRepository,
	ImportRowOutcomeCounts,
	ImportRowPage,
	ImportSweepInput,
} from './repository.ts';

const JOB_COLUMNS = `id, tenant_id, target, document_id, document_ref, mode,
	dry_run, valid_only, status, total_rows, valid_rows, written_rows,
	failed_rows, requester_account_id, requester_json, columns_json,
	failure_code, claimed_at, started_at, completed_at, traceparent`;

const ROW_COLUMNS = `id, tenant_id, job_id, row_number, outcome, field, reason,
	record_ref`;

/* Queries stay explicit and every value travels through the parameter channel;
   no import data is ever concatenated into SQL. */
const SQL = {
	insertJob: `INSERT INTO import_jobs (${JOB_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
	         $16, $17, $18, $19, $20, $21)`,

	findJob: `SELECT ${JOB_COLUMNS} FROM import_jobs
	 WHERE tenant_id = $1 AND id = $2`,

	/* The `from` statuses are appended as bound parameters by `advanceJob`: the
	   adapter's parameter channel carries scalars, not arrays. */
	advanceJob: `UPDATE import_jobs
	 SET status = $3, total_rows = $4, valid_rows = $5, written_rows = $6,
	     failed_rows = $7, failure_code = $8, completed_at = $9,
	     claimed_at = NULL
	 WHERE tenant_id = $1 AND id = $2 AND status IN `,

	continueJob: `UPDATE import_jobs SET status = 'writing', valid_only = $3
	 WHERE tenant_id = $1 AND id = $2 AND status = 'validated'
	 RETURNING ${JOB_COLUMNS}`,

	/* One statement, so two platform processes cannot both take one job. A
	   claim older than the lease belonged to a process that is gone. */
	claimJob: `UPDATE import_jobs SET claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2
	   AND status IN ('parsing', 'writing')
	   AND (claimed_at IS NULL OR claimed_at <= $4)
	 RETURNING ${JOB_COLUMNS}`,

	/* Renewed once per batch by the stage that holds the claim. The status guard
	   keeps a job that already settled from looking claimed again, and the claim
	   guard keeps a stage whose lease lapsed from renewing a claim that is now
	   somebody else's. */
	heartbeatJob: `UPDATE import_jobs SET claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2 AND claimed_at = $4
	   AND status IN ('parsing', 'writing')`,

	/* Read through the cross-tenant background lease, which is granted these
	   four columns and no others. */
	listPendingJobs: `SELECT tenant_id, id, status, started_at
	 FROM import_jobs
	 WHERE status IN ('parsing', 'writing')
	 ORDER BY started_at, tenant_id, id
	 LIMIT $1`,

	deleteJobRows:
		'DELETE FROM import_job_rows WHERE tenant_id = $1 AND job_id = $2',

	listJobRows: `SELECT ${ROW_COLUMNS} FROM import_job_rows
	 WHERE tenant_id = $1 AND job_id = $2 AND row_number > $3
	 ORDER BY row_number LIMIT $4`,

	listValidRowNumbers: `SELECT row_number FROM import_job_rows
	 WHERE tenant_id = $1 AND job_id = $2 AND outcome = 'valid'
	 ORDER BY row_number`,

	countRowOutcomes: `SELECT outcome, count(*) AS rows FROM import_job_rows
	 WHERE tenant_id = $1 AND job_id = $2
	 GROUP BY outcome`,

	findMapping: `SELECT id, tenant_id, target, columns_json, updated_at
	 FROM import_mappings WHERE tenant_id = $1 AND target = $2`,

	saveMapping: `INSERT INTO import_mappings
	 (id, tenant_id, target, columns_json, updated_at)
	 VALUES ($1, $2, $3, $4, $5)
	 ON CONFLICT (tenant_id, target) DO UPDATE
	 SET columns_json = EXCLUDED.columns_json, updated_at = EXCLUDED.updated_at
	 RETURNING id, tenant_id, target, columns_json, updated_at`,

	/* A job nobody continued is settled before the retention gate sees it, so an
	   abandoned validated job leaves the queue instead of waiting out its whole
	   retention as work in flight. */
	expireValidatedJobs: `UPDATE import_jobs
	 SET status = 'cancelled', completed_at = $4, claimed_at = NULL
	 WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM import_jobs
	   WHERE tenant_id = $1 AND status = 'validated' AND started_at < $2
	   ORDER BY started_at, id LIMIT $3)`,

	/* The batch is chosen once and both deletes read that one set: two
	   independently ordered LIMIT subqueries could pick different jobs on a tie
	   and leave outcomes behind whose job is gone. */
	sweepJobs: `WITH doomed AS (
	   SELECT id FROM import_jobs
	   WHERE tenant_id = $1 AND started_at < $2
	     AND status IN ('completed', 'failed', 'cancelled')
	   ORDER BY started_at, id LIMIT $3
	 ), swept_rows AS (
	   DELETE FROM import_job_rows
	   WHERE tenant_id = $1 AND job_id IN (SELECT id FROM doomed)
	 )
	 DELETE FROM import_jobs
	 WHERE tenant_id = $1 AND id IN (SELECT id FROM doomed)`,

	exportPage: `SELECT ${JOB_COLUMNS} FROM import_jobs
	 WHERE tenant_id = $1 AND (started_at, id) > ($2, $3)
	 ORDER BY started_at, id LIMIT $4`,

	exportRowsPage: `SELECT ${ROW_COLUMNS} FROM import_job_rows
	 WHERE tenant_id = $1 AND (job_id, row_number) > ($2, $3)
	 ORDER BY job_id, row_number LIMIT $4`,

	exportMappingsPage: `SELECT id, tenant_id, target, columns_json, updated_at
	 FROM import_mappings WHERE tenant_id = $1 AND target > $2
	 ORDER BY target LIMIT $3`,
} as const;

interface JobRow {
	id: string;
	tenant_id: string;
	target: string;
	document_id: string;
	document_ref: string;
	mode: ImportMode;
	dry_run: number | string;
	valid_only: number | string;
	status: ImportJobStatus;
	total_rows: number | bigint | string;
	valid_rows: number | bigint | string;
	written_rows: number | bigint | string;
	failed_rows: number | bigint | string;
	requester_account_id: string;
	requester_json: string;
	columns_json: string;
	failure_code: string | null;
	claimed_at: number | bigint | string | null;
	started_at: number | bigint | string;
	completed_at: number | bigint | string | null;
	traceparent: string | null;
}

interface OutcomeRow {
	id: string;
	tenant_id: string;
	job_id: string;
	row_number: number | bigint | string;
	outcome: ImportRowOutcome;
	field: string | null;
	reason: string | null;
	record_ref: string | null;
}

/* PostgreSQL returns BIGINT as a string, so every integer read crosses this
   instead of trusting the driver's representation. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The import database returned an invalid ${field}.`);
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

/* A column written by this module, so a parse failure is corruption rather than
   input; the stable message names the column instead of leaking the payload. */
function jsonObject(raw: string, field: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`The import database returned an invalid ${field}.`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`The import database returned an invalid ${field}.`);
	}
	return parsed as Record<string, string>;
}

function requesterOf(raw: string): ImportRequester {
	const parsed = jsonObject(raw, 'requester') as unknown as ImportRequester;
	return {
		accountId: String(parsed.accountId ?? ''),
		email: String(parsed.email ?? ''),
		displayName: String(parsed.displayName ?? ''),
		role: String(parsed.role ?? ''),
		scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : [],
	};
}

function jobFromRow(row: JobRow): ImportJob {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		target: row.target,
		documentId: row.document_id,
		documentRef: row.document_ref,
		mode: row.mode,
		dryRun: Number(row.dry_run) === 1,
		validOnly: Number(row.valid_only) === 1,
		status: row.status,
		totalRows: integer(row.total_rows, 'row count'),
		validRows: integer(row.valid_rows, 'row count'),
		writtenRows: integer(row.written_rows, 'row count'),
		failedRows: integer(row.failed_rows, 'row count'),
		requesterAccountId: row.requester_account_id,
		requester: requesterOf(row.requester_json),
		columns: jsonObject(row.columns_json, 'mapping'),
		failureCode: row.failure_code,
		claimedAt: optionalInteger(row.claimed_at, 'timestamp'),
		startedAt: integer(row.started_at, 'timestamp'),
		completedAt: optionalInteger(row.completed_at, 'timestamp'),
		traceparent: row.traceparent,
	};
}

function rowFromRow(row: OutcomeRow): ImportJobRow {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		jobId: row.job_id,
		rowNumber: integer(row.row_number, 'row number'),
		outcome: row.outcome,
		field: row.field,
		reason: row.reason,
		recordRef: row.record_ref,
	};
}

function jobParameters(job: ImportJob): readonly (string | number | null)[] {
	return [
		job.id,
		job.tenantId,
		job.target,
		job.documentId,
		job.documentRef,
		job.mode,
		job.dryRun ? 1 : 0,
		job.validOnly ? 1 : 0,
		job.status,
		job.totalRows,
		job.validRows,
		job.writtenRows,
		job.failedRows,
		job.requesterAccountId,
		JSON.stringify(job.requester),
		JSON.stringify(job.columns),
		job.failureCode,
		job.claimedAt,
		job.startedAt,
		job.completedAt,
		job.traceparent,
	];
}

/** Rows per INSERT; eight parameters each stays far inside the bind limit. */
const INSERT_CHUNK = 250;
const EXPORT_PAGE = 500;

export async function migrateImportDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'import.core', databaseMigrations);
}

export interface ImportDatabaseHandles {
	readonly runtime: DatabaseHandle;
	/** Cross-tenant, read only, granted the job routing columns alone. */
	readonly background: DatabaseHandle;
}

export class DatabaseImportRepository implements ImportRepository {
	readonly #handles: ImportDatabaseHandles;

	constructor(handles: ImportDatabaseHandles) {
		this.#handles = handles;
	}

	async createJob(job: ImportJob): Promise<ImportJob> {
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

	async findJob(tenantId: string, id: string): Promise<ImportJob | null> {
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
		query: ImportJobQuery,
	): Promise<ImportJobPage> {
		const parameters: (string | number)[] = [tenantId];
		let text = `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE tenant_id = $1`;
		if (query.status) {
			parameters.push(query.status);
			text += ` AND status = $${parameters.length}`;
		}
		if (query.target) {
			parameters.push(query.target);
			text += ` AND target = $${parameters.length}`;
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

	async advanceJob(
		tenantId: string,
		id: string,
		from: readonly ImportJobStatus[],
		result: ImportJobResult,
	): Promise<ImportJob | null> {
		const parameters: (string | number | null)[] = [
			tenantId,
			id,
			result.status,
			result.totalRows,
			result.validRows,
			result.writtenRows,
			result.failedRows,
			result.failureCode,
			result.completedAt,
		];
		const placeholders = from.map((status) => {
			parameters.push(status);
			return `$${parameters.length}`;
		});
		const answered = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<JobRow>({
					text:
						`${SQL.advanceJob}(${placeholders.join(', ')})` +
						` RETURNING ${JOB_COLUMNS}`,
					parameters,
				}),
			{ access: 'write', tenantId },
		);
		const row = answered.rows[0];
		return row ? jobFromRow(row) : null;
	}

	async continueJob(
		tenantId: string,
		id: string,
		validOnly: boolean,
	): Promise<ImportJob | null> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<JobRow>({
					text: SQL.continueJob,
					parameters: [tenantId, id, validOnly ? 1 : 0],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
		return row ? jobFromRow(row) : null;
	}

	async claimJob(input: ClaimJobInput): Promise<ClaimedImportJob | null> {
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
		/* The statement wrote this instant, so it is the claim the stage renews
		   under rather than whatever the row carried before. */
		return row ? { ...jobFromRow(row), claimedAt: input.claimedAt } : null;
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

	async listPendingJobs(limit: number): Promise<readonly ImportJobRouting[]> {
		const result = await this.#handles.background.query<{
			tenant_id: string;
			id: string;
			status: ImportJobStatus;
			started_at: number | bigint | string;
		}>({ text: SQL.listPendingJobs, parameters: [limit] });
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			status: row.status,
			startedAt: integer(row.started_at, 'timestamp'),
		}));
	}

	async replaceJobRows(
		tenantId: string,
		jobId: string,
		rows: readonly ImportJobRow[],
	): Promise<void> {
		await this.#handles.runtime.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SQL.deleteJobRows,
					parameters: [tenantId, jobId],
				});
				await this.#insertRows(transaction, rows);
			},
			{ access: 'write', tenantId },
		);
	}

	async recordJobRows(
		tenantId: string,
		rows: readonly ImportJobRow[],
	): Promise<void> {
		if (rows.length === 0) return;
		await this.#handles.runtime.transaction(
			(transaction) => this.#insertRows(transaction, rows),
			{ access: 'write', tenantId },
		);
	}

	async listJobRows(
		tenantId: string,
		jobId: string,
		limit: number,
		after = 0,
	): Promise<ImportRowPage> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<OutcomeRow>({
					text: SQL.listJobRows,
					parameters: [tenantId, jobId, after, limit + 1],
				}),
			{ access: 'read', tenantId },
		);
		const items = result.rows.slice(0, limit).map(rowFromRow);
		const last = items[items.length - 1];
		return {
			items,
			nextCursor: result.rows.length > limit && last ? last.rowNumber : null,
		};
	}

	async listValidRowNumbers(
		tenantId: string,
		jobId: string,
	): Promise<readonly number[]> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<{ row_number: number | bigint | string }>({
					text: SQL.listValidRowNumbers,
					parameters: [tenantId, jobId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => integer(row.row_number, 'row number'));
	}

	async countRowOutcomes(
		tenantId: string,
		jobId: string,
	): Promise<ImportRowOutcomeCounts> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<{
					outcome: ImportRowOutcome;
					rows: number | bigint | string;
				}>({ text: SQL.countRowOutcomes, parameters: [tenantId, jobId] }),
			{ access: 'read', tenantId },
		);
		const counts: Record<ImportRowOutcome, number> = {
			valid: 0,
			invalid: 0,
			created: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
		};
		for (const row of result.rows) {
			counts[row.outcome] = integer(row.rows, 'row count');
		}
		return counts;
	}

	async findMapping(
		tenantId: string,
		target: string,
	): Promise<ImportMapping | null> {
		const result = await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.query<{
					id: string;
					tenant_id: string;
					target: string;
					columns_json: string;
					updated_at: number | bigint | string;
				}>({ text: SQL.findMapping, parameters: [tenantId, target] }),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row
			? {
					id: row.id,
					tenantId: row.tenant_id,
					target: row.target,
					columns: jsonObject(row.columns_json, 'mapping'),
					updatedAt: integer(row.updated_at, 'timestamp'),
				}
			: null;
	}

	async saveMapping(mapping: ImportMapping): Promise<ImportMapping> {
		await this.#handles.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.saveMapping,
					parameters: [
						mapping.id,
						mapping.tenantId,
						mapping.target,
						JSON.stringify(mapping.columns),
						mapping.updatedAt,
					],
				}),
			{ access: 'write', tenantId: mapping.tenantId },
		);
		return mapping;
	}

	async sweepJobs(tenantId: string, input: ImportSweepInput): Promise<number> {
		return this.#handles.runtime.transaction(
			async (transaction) => {
				/* An abandoned job settles first, so this pass can already remove one
				   whose retention has run out as well. */
				await transaction.execute({
					text: SQL.expireValidatedJobs,
					parameters: [tenantId, input.abandonedBefore, input.limit, input.at],
				});
				const removed = await transaction.execute({
					text: SQL.sweepJobs,
					parameters: [tenantId, input.settledBefore, input.limit],
				});
				return removed.affectedRows;
			},
			{ access: 'write', tenantId },
		);
	}

	/**
	 * Everything the class holds for one workspace: the jobs, the row outcomes
	 * of each of them and the saved mappings. Each table is walked by its own
	 * ascending key, so no page holds more than `EXPORT_PAGE` rows however long
	 * the history is, and every record names its kind because one sink carries
	 * all three. The reported range covers the records that carry a time of
	 * their own; a row outcome is dated by the job it belongs to.
	 */
	async exportJobs(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<{ rows: number; from: Date | null; to: Date | null }> {
		let rows = 0;
		let from: Date | null = null;
		let to: Date | null = null;
		const observe = (value: number): void => {
			const instant = new Date(value);
			if (from === null || instant < from) from = instant;
			if (to === null || instant > to) to = instant;
		};
		const page = <Row extends object>(
			text: string,
			parameters: (string | number)[],
		) =>
			this.#handles.runtime.transaction(
				(transaction) => transaction.query<Row>({ text, parameters }),
				{ access: 'read', tenantId },
			);

		let job: { startedAt: number; id: string } = { startedAt: 0, id: '' };
		for (;;) {
			const found = await page<JobRow>(SQL.exportPage, [
				tenantId,
				job.startedAt,
				job.id,
				EXPORT_PAGE,
			]);
			for (const row of found.rows) {
				const record = jobFromRow(row);
				await sink.write({
					record: 'job',
					id: record.id,
					target: record.target,
					documentId: record.documentId,
					mode: record.mode,
					dryRun: record.dryRun,
					status: record.status,
					totalRows: record.totalRows,
					validRows: record.validRows,
					writtenRows: record.writtenRows,
					failedRows: record.failedRows,
					requesterAccountId: record.requesterAccountId,
					columns: record.columns,
					failureCode: record.failureCode,
					startedAt: new Date(record.startedAt).toISOString(),
					completedAt:
						record.completedAt === null
							? null
							: new Date(record.completedAt).toISOString(),
				});
				rows += 1;
				observe(record.startedAt);
				job = { startedAt: record.startedAt, id: record.id };
			}
			if (found.rows.length < EXPORT_PAGE) break;
		}

		let outcome: { jobId: string; rowNumber: number } = {
			jobId: '',
			rowNumber: 0,
		};
		for (;;) {
			const found = await page<OutcomeRow>(SQL.exportRowsPage, [
				tenantId,
				outcome.jobId,
				outcome.rowNumber,
				EXPORT_PAGE,
			]);
			for (const row of found.rows) {
				const record = rowFromRow(row);
				await sink.write({
					record: 'row-outcome',
					id: record.id,
					jobId: record.jobId,
					rowNumber: record.rowNumber,
					outcome: record.outcome,
					field: record.field,
					reason: record.reason,
					recordRef: record.recordRef,
				});
				rows += 1;
				outcome = { jobId: record.jobId, rowNumber: record.rowNumber };
			}
			if (found.rows.length < EXPORT_PAGE) break;
		}

		let target = '';
		for (;;) {
			const found = await page<{
				id: string;
				target: string;
				columns_json: string;
				updated_at: number | bigint | string;
			}>(SQL.exportMappingsPage, [tenantId, target, EXPORT_PAGE]);
			for (const row of found.rows) {
				const updatedAt = integer(row.updated_at, 'timestamp');
				await sink.write({
					record: 'mapping',
					id: row.id,
					target: row.target,
					columns: jsonObject(row.columns_json, 'mapping'),
					updatedAt: new Date(updatedAt).toISOString(),
				});
				rows += 1;
				observe(updatedAt);
				target = row.target;
			}
			if (found.rows.length < EXPORT_PAGE) break;
		}

		return { rows, from, to };
	}

	async #insertRows(
		transaction: DatabaseTransaction,
		rows: readonly ImportJobRow[],
	): Promise<void> {
		for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
			const chunk = rows.slice(start, start + INSERT_CHUNK);
			const values: string[] = [];
			const parameters: (string | number | null)[] = [];
			for (const row of chunk) {
				const base = parameters.length;
				values.push(
					`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},` +
						` $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
				);
				parameters.push(
					row.id,
					row.tenantId,
					row.jobId,
					row.rowNumber,
					row.outcome,
					row.field,
					row.reason,
					row.recordRef,
				);
			}
			await transaction.execute({
				text:
					`INSERT INTO import_job_rows (${ROW_COLUMNS}) VALUES ` +
					`${values.join(', ')}
					 ON CONFLICT (tenant_id, job_id, row_number) DO UPDATE
					 SET outcome = EXCLUDED.outcome, field = EXCLUDED.field,
					     reason = EXCLUDED.reason, record_ref = EXCLUDED.record_ref`,
				parameters,
			});
		}
	}
}
