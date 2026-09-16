import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import { integer, runDatabaseMigrations } from '@flowdular/database';
import type { DataClassExportSink } from '@flowdular/kernel';
import type {
	AdapterDirection,
	AdapterJson,
	AdapterMappingRule,
} from '../domain/registry.ts';
import type {
	AdapterAuditAction,
	AdapterAuditEvent,
	AdapterBinding,
	AdapterDueBinding,
	AdapterRowOutcome,
	AdapterRun,
	AdapterRunRouting,
	AdapterRunRow,
	AdapterRunStatus,
	AdapterRunTrigger,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	AdaptersRepository,
	ClaimRunInput,
	ExportSummary,
	FinishRunInput,
	PageCommit,
	RunPage,
	RunPosition,
	RunRowPage,
	ScheduleFireInput,
	ScheduleFireResult,
} from './repository.ts';

type Scalar = string | number | null;
type Stored = number | bigint | string;

const BINDING_COLUMNS = `tenant_id, adapter_id, instance_id, enabled,
	mapping_json, schedule, next_run_at, updated_by, updated_at`;

const RUN_COLUMNS = `tenant_id, id, adapter_id, direction, status, trigger,
	resumed_from, cursor, pages, rows_read, rows_created, rows_updated,
	rows_skipped, rows_failed, error_code, claimed_by, lease_until, queued_at,
	started_at, finished_at, started_by`;

const ROW_COLUMNS = `tenant_id, run_id, row_index, natural_key, outcome,
	error_code, message`;

const AUDIT_COLUMNS = `tenant_id, id, adapter_id, run_id, action, actor_id,
	metadata_json, occurred_at`;

/* Every value travels through the parameter channel; nothing a workspace or a
   foreign system supplied is concatenated into SQL. */
const SQL = {
	findBinding: `SELECT ${BINDING_COLUMNS} FROM adapter_bindings
	 WHERE tenant_id = $1 AND adapter_id = $2`,
	listBindings: `SELECT ${BINDING_COLUMNS} FROM adapter_bindings
	 WHERE tenant_id = $1 ORDER BY adapter_id`,
	saveBinding: `INSERT INTO adapter_bindings (${BINDING_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	 ON CONFLICT (tenant_id, adapter_id) DO UPDATE SET
	   instance_id = EXCLUDED.instance_id, enabled = EXCLUDED.enabled,
	   mapping_json = EXCLUDED.mapping_json, schedule = EXCLUDED.schedule,
	   next_run_at = EXCLUDED.next_run_at, updated_by = EXCLUDED.updated_by,
	   updated_at = EXCLUDED.updated_at`,

	latestRuns: `SELECT DISTINCT ON (adapter_id) ${RUN_COLUMNS} FROM adapter_runs
	 WHERE tenant_id = $1 ORDER BY adapter_id, queued_at DESC, id DESC`,
	latestRun: `SELECT ${RUN_COLUMNS} FROM adapter_runs
	 WHERE tenant_id = $1 AND adapter_id = $2
	 ORDER BY queued_at DESC, id DESC LIMIT 1`,
	/* The conflict target is the partial index of active runs, so a second
	   queued run of one adapter is absorbed while any other conflict raises. */
	createRun: `INSERT INTO adapter_runs (${RUN_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
	         $16, $17, $18, $19, $20, $21)
	 ON CONFLICT (tenant_id, adapter_id) WHERE status IN ('queued', 'running')
	 DO NOTHING`,
	findRun: `SELECT ${RUN_COLUMNS} FROM adapter_runs
	 WHERE tenant_id = $1 AND id = $2`,
	cancelRun: `UPDATE adapter_runs
	 SET status = 'cancelled', finished_at = $3, claimed_by = NULL,
	     lease_until = NULL
	 WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')
	 RETURNING ${RUN_COLUMNS}`,
	listRunRows: `SELECT ${ROW_COLUMNS} FROM adapter_run_rows
	 WHERE tenant_id = $1 AND run_id = $2 AND row_index > $3
	 ORDER BY row_index LIMIT $4`,

	/* Read through the cross-tenant background lease, which is granted these
	   columns and no others. A run whose lease is live belongs to a process
	   that is still working, so it is not offered again. */
	listPendingRuns: `SELECT tenant_id, id FROM adapter_runs
	 WHERE status IN ('queued', 'running')
	   AND (lease_until IS NULL OR lease_until <= $1)
	 ORDER BY queued_at, tenant_id, id LIMIT $2`,
	/* One statement, so two processes cannot both take one run. */
	claimRun: `UPDATE adapter_runs
	 SET status = 'running', claimed_by = $3, lease_until = $5,
	     started_at = COALESCE(started_at, $4)
	 WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')
	   AND (lease_until IS NULL OR lease_until <= $4)
	 RETURNING ${RUN_COLUMNS}`,
	heartbeatRun: `UPDATE adapter_runs SET lease_until = $4
	 WHERE tenant_id = $1 AND id = $2 AND claimed_by = $3 AND status = 'running'`,
	advanceRun: `UPDATE adapter_runs
	 SET cursor = $4, pages = pages + 1, rows_read = rows_read + $5,
	     rows_created = rows_created + $6, rows_updated = rows_updated + $7,
	     rows_skipped = rows_skipped + $8, rows_failed = rows_failed + $9
	 WHERE tenant_id = $1 AND id = $2 AND claimed_by = $3 AND status = 'running'`,
	finishRun: `UPDATE adapter_runs
	 SET status = $4, error_code = $5, finished_at = $6, claimed_by = NULL,
	     lease_until = NULL
	 WHERE tenant_id = $1 AND id = $2 AND claimed_by = $3 AND status = 'running'
	 RETURNING ${RUN_COLUMNS}`,

	listDueBindings: `SELECT tenant_id, adapter_id, next_run_at
	 FROM adapter_bindings
	 WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $1
	 ORDER BY next_run_at, tenant_id, adapter_id LIMIT $2`,
	/* The compare and swap is the fence: a pass that read a stale next time
	   moves nothing and queues nothing. */
	moveSchedule: `UPDATE adapter_bindings SET next_run_at = $4
	 WHERE tenant_id = $1 AND adapter_id = $2 AND enabled = 1
	   AND next_run_at = $3
	 RETURNING updated_by`,

	appendAudit: `INSERT INTO adapter_audit_events (${AUDIT_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,

	sweepRuns: `DELETE FROM adapter_runs
	 WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM adapter_runs
	   WHERE tenant_id = $1 AND finished_at IS NOT NULL AND finished_at < $2
	   ORDER BY finished_at, id LIMIT $3)`,
	sweepRunRows: `DELETE FROM adapter_run_rows
	 WHERE tenant_id = $1 AND (run_id, row_index) IN (
	   SELECT row_entry.run_id, row_entry.row_index
	   FROM adapter_run_rows AS row_entry
	   JOIN adapter_runs AS run
	     ON run.tenant_id = row_entry.tenant_id AND run.id = row_entry.run_id
	   WHERE row_entry.tenant_id = $1 AND run.finished_at IS NOT NULL
	     AND run.finished_at < $2
	   ORDER BY run.finished_at, row_entry.run_id, row_entry.row_index
	   LIMIT $3)`,
	exportRuns: `SELECT ${RUN_COLUMNS} FROM adapter_runs
	 WHERE tenant_id = $1 AND (queued_at, id) > ($2, $3)
	 ORDER BY queued_at, id LIMIT $4`,
	exportRunRows: `SELECT ${ROW_COLUMNS} FROM adapter_run_rows
	 WHERE tenant_id = $1 AND (run_id, row_index) > ($2, $3)
	 ORDER BY run_id, row_index LIMIT $4`,
	exportBindings: `SELECT ${BINDING_COLUMNS} FROM adapter_bindings
	 WHERE tenant_id = $1 AND adapter_id > $2 ORDER BY adapter_id LIMIT $3`,
	exportAudit: `SELECT ${AUDIT_COLUMNS} FROM adapter_audit_events
	 WHERE tenant_id = $1 AND (occurred_at, id) > ($2, $3)
	 ORDER BY occurred_at, id LIMIT $4`,
} as const;

/* The erasure statements per table: the account column is emptied and the
   row stays, bounded per call so the platform loop asks again until none
   remain. */
const ERASURE = {
	runs: {
		erase: `UPDATE adapter_runs SET started_by = NULL
		 WHERE tenant_id = $1 AND id IN (
		   SELECT id FROM adapter_runs WHERE tenant_id = $1 AND started_by = $2
		   ORDER BY id LIMIT $3)`,
		count: `SELECT count(*) AS rows FROM adapter_runs
		 WHERE tenant_id = $1 AND started_by = $2`,
	},
	bindings: {
		erase: `UPDATE adapter_bindings SET updated_by = NULL
		 WHERE tenant_id = $1 AND adapter_id IN (
		   SELECT adapter_id FROM adapter_bindings
		   WHERE tenant_id = $1 AND updated_by = $2
		   ORDER BY adapter_id LIMIT $3)`,
		count: `SELECT count(*) AS rows FROM adapter_bindings
		 WHERE tenant_id = $1 AND updated_by = $2`,
	},
	audit: {
		erase: `UPDATE adapter_audit_events SET actor_id = NULL
		 WHERE tenant_id = $1 AND id IN (
		   SELECT id FROM adapter_audit_events
		   WHERE tenant_id = $1 AND actor_id = $2
		   ORDER BY id LIMIT $3)`,
		count: `SELECT count(*) AS rows FROM adapter_audit_events
		 WHERE tenant_id = $1 AND actor_id = $2`,
	},
} as const;

interface BindingRow {
	tenant_id: string;
	adapter_id: string;
	instance_id: string | null;
	enabled: Stored;
	mapping_json: string | null;
	schedule: string | null;
	next_run_at: Stored | null;
	updated_by: string | null;
	updated_at: Stored;
}

interface RunRow {
	tenant_id: string;
	id: string;
	adapter_id: string;
	direction: AdapterDirection;
	status: AdapterRunStatus;
	trigger: AdapterRunTrigger;
	resumed_from: string | null;
	cursor: string | null;
	pages: Stored;
	rows_read: Stored;
	rows_created: Stored;
	rows_updated: Stored;
	rows_skipped: Stored;
	rows_failed: Stored;
	error_code: string | null;
	claimed_by: string | null;
	lease_until: Stored | null;
	queued_at: Stored;
	started_at: Stored | null;
	finished_at: Stored | null;
	started_by: string | null;
}

interface OutcomeRow {
	tenant_id: string;
	run_id: string;
	row_index: Stored;
	natural_key: string | null;
	outcome: AdapterRowOutcome;
	error_code: string | null;
	message: string | null;
}

interface AuditRow {
	tenant_id: string;
	id: string;
	adapter_id: string;
	run_id: string | null;
	action: AdapterAuditAction;
	actor_id: string | null;
	metadata_json: string;
	occurred_at: Stored;
}

function optional(value: Stored | null, field: string): number | null {
	return value === null ? null : integer(value, field);
}

/* A column this module wrote, so a parse failure is corruption rather than
   input; the message names the column and never the payload. */
function parsed<T>(raw: string, field: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`The adapters database returned an invalid ${field}.`);
	}
}

function bindingOf(row: BindingRow): AdapterBinding {
	return {
		tenantId: row.tenant_id,
		adapterId: row.adapter_id,
		instanceId: row.instance_id,
		enabled: Number(row.enabled) === 1,
		mapping:
			row.mapping_json === null
				? null
				: parsed<readonly AdapterMappingRule[]>(row.mapping_json, 'mapping'),
		schedule: row.schedule,
		nextRunAt: optional(row.next_run_at, 'timestamp'),
		updatedBy: row.updated_by,
		updatedAt: integer(row.updated_at, 'timestamp'),
	};
}

function runOf(row: RunRow): AdapterRun {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		adapterId: row.adapter_id,
		direction: row.direction,
		status: row.status,
		trigger: row.trigger,
		resumedFrom: row.resumed_from,
		cursor: row.cursor,
		pages: integer(row.pages, 'page count'),
		rowsRead: integer(row.rows_read, 'row count'),
		rowsCreated: integer(row.rows_created, 'row count'),
		rowsUpdated: integer(row.rows_updated, 'row count'),
		rowsSkipped: integer(row.rows_skipped, 'row count'),
		rowsFailed: integer(row.rows_failed, 'row count'),
		errorCode: row.error_code,
		claimedBy: row.claimed_by,
		leaseUntil: optional(row.lease_until, 'timestamp'),
		queuedAt: integer(row.queued_at, 'timestamp'),
		startedAt: optional(row.started_at, 'timestamp'),
		finishedAt: optional(row.finished_at, 'timestamp'),
		startedBy: row.started_by,
	};
}

function outcomeOf(row: OutcomeRow): AdapterRunRow {
	return {
		tenantId: row.tenant_id,
		runId: row.run_id,
		rowIndex: integer(row.row_index, 'row index'),
		naturalKey: row.natural_key,
		outcome: row.outcome,
		errorCode: row.error_code,
		message: row.message,
	};
}

function auditOf(row: AuditRow): AdapterAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		adapterId: row.adapter_id,
		runId: row.run_id,
		action: row.action,
		actorId: row.actor_id,
		metadata: parsed<Readonly<Record<string, AdapterJson>>>(
			row.metadata_json,
			'audit metadata',
		),
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

function runParameters(run: AdapterRun): readonly Scalar[] {
	return [
		run.tenantId,
		run.id,
		run.adapterId,
		run.direction,
		run.status,
		run.trigger,
		run.resumedFrom,
		run.cursor,
		run.pages,
		run.rowsRead,
		run.rowsCreated,
		run.rowsUpdated,
		run.rowsSkipped,
		run.rowsFailed,
		run.errorCode,
		run.claimedBy,
		run.leaseUntil,
		run.queuedAt,
		run.startedAt,
		run.finishedAt,
		run.startedBy,
	];
}

function auditParameters(event: AdapterAuditEvent): readonly Scalar[] {
	return [
		event.tenantId,
		event.id,
		event.adapterId,
		event.runId,
		event.action,
		event.actorId,
		JSON.stringify(event.metadata),
		event.occurredAt,
	];
}

/** Rows per INSERT; seven parameters each stays far inside the bind limit. */
const INSERT_CHUNK = 250;
const EXPORT_PAGE = 500;

export async function migrateAdaptersDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'adapters.core', databaseMigrations);
}

export interface AdaptersDatabaseHandles {
	readonly runtime: DatabaseHandle;
	/** Cross-tenant, read only, granted the routing columns alone. */
	readonly background: DatabaseHandle;
}

export class DatabaseAdaptersRepository implements AdaptersRepository {
	readonly #handles: AdaptersDatabaseHandles;

	constructor(handles: AdaptersDatabaseHandles) {
		this.#handles = handles;
	}

	#read<T>(
		tenantId: string,
		work: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.#handles.runtime.transaction(work, {
			access: 'read',
			tenantId,
		});
	}

	#write<T>(
		tenantId: string,
		work: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.#handles.runtime.transaction(work, {
			access: 'write',
			tenantId,
		});
	}

	async findBinding(
		tenantId: string,
		adapterId: string,
	): Promise<AdapterBinding | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<BindingRow>({
				text: SQL.findBinding,
				parameters: [tenantId, adapterId],
			}),
		);
		const row = result.rows[0];
		return row ? bindingOf(row) : null;
	}

	async listBindings(tenantId: string): Promise<readonly AdapterBinding[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<BindingRow>({
				text: SQL.listBindings,
				parameters: [tenantId],
			}),
		);
		return result.rows.map(bindingOf);
	}

	async saveBinding(
		binding: AdapterBinding,
		events: readonly AdapterAuditEvent[],
	): Promise<AdapterBinding> {
		await this.#write(binding.tenantId, async (transaction) => {
			await transaction.execute({
				text: SQL.saveBinding,
				parameters: [
					binding.tenantId,
					binding.adapterId,
					binding.instanceId,
					binding.enabled ? 1 : 0,
					binding.mapping === null ? null : JSON.stringify(binding.mapping),
					binding.schedule,
					binding.nextRunAt,
					binding.updatedBy,
					binding.updatedAt,
				],
			});
			for (const event of events) {
				await transaction.execute({
					text: SQL.appendAudit,
					parameters: auditParameters(event),
				});
			}
		});
		return binding;
	}

	async latestRuns(tenantId: string): Promise<readonly AdapterRun[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<RunRow>({
				text: SQL.latestRuns,
				parameters: [tenantId],
			}),
		);
		return result.rows.map(runOf);
	}

	async latestRun(
		tenantId: string,
		adapterId: string,
	): Promise<AdapterRun | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<RunRow>({
				text: SQL.latestRun,
				parameters: [tenantId, adapterId],
			}),
		);
		const row = result.rows[0];
		return row ? runOf(row) : null;
	}

	async createRun(run: AdapterRun, event: AdapterAuditEvent): Promise<boolean> {
		return this.#write(run.tenantId, async (transaction) => {
			const inserted = await transaction.execute({
				text: SQL.createRun,
				parameters: runParameters(run),
			});
			if (inserted.affectedRows === 0) return false;
			await transaction.execute({
				text: SQL.appendAudit,
				parameters: auditParameters(event),
			});
			return true;
		});
	}

	async findRun(tenantId: string, id: string): Promise<AdapterRun | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<RunRow>({
				text: SQL.findRun,
				parameters: [tenantId, id],
			}),
		);
		const row = result.rows[0];
		return row ? runOf(row) : null;
	}

	async listRuns(
		tenantId: string,
		query: {
			readonly adapterId?: string | undefined;
			readonly limit: number;
			readonly after?: RunPosition | null | undefined;
		},
	): Promise<RunPage> {
		const parameters: Scalar[] = [tenantId];
		let text = `SELECT ${RUN_COLUMNS} FROM adapter_runs WHERE tenant_id = $1`;
		if (query.adapterId) {
			parameters.push(query.adapterId);
			text += ` AND adapter_id = $${parameters.length}`;
		}
		if (query.after) {
			parameters.push(query.after.queuedAt, query.after.id);
			text += ` AND (queued_at, id) < ($${parameters.length - 1}, $${parameters.length})`;
		}
		/* One row past the page says whether another page exists without a
		   count over the workspace's runs. */
		parameters.push(query.limit + 1);
		text += ` ORDER BY queued_at DESC, id DESC LIMIT $${parameters.length}`;
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<RunRow>({ text, parameters }),
		);
		const items = result.rows.slice(0, query.limit).map(runOf);
		const last = items.at(-1);
		return {
			items,
			next:
				result.rows.length > query.limit && last
					? { queuedAt: last.queuedAt, id: last.id }
					: null,
		};
	}

	async listRunRows(
		tenantId: string,
		runId: string,
		limit: number,
		after: number | null = null,
	): Promise<RunRowPage> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<OutcomeRow>({
				text: SQL.listRunRows,
				parameters: [tenantId, runId, after ?? 0, limit + 1],
			}),
		);
		const items = result.rows.slice(0, limit).map(outcomeOf);
		const last = items.at(-1);
		return {
			items,
			next: result.rows.length > limit && last ? last.rowIndex : null,
		};
	}

	async cancelRun(
		tenantId: string,
		id: string,
		at: number,
		event: AdapterAuditEvent,
	): Promise<AdapterRun | null> {
		return this.#write(tenantId, async (transaction) => {
			const result = await transaction.query<RunRow>({
				text: SQL.cancelRun,
				parameters: [tenantId, id, at],
			});
			const row = result.rows[0];
			if (!row) return null;
			await transaction.execute({
				text: SQL.appendAudit,
				parameters: auditParameters(event),
			});
			return runOf(row);
		});
	}

	async listPendingRuns(
		now: number,
		limit: number,
	): Promise<readonly AdapterRunRouting[]> {
		const result = await this.#handles.background.query<{
			tenant_id: string;
			id: string;
		}>({ text: SQL.listPendingRuns, parameters: [now, limit] });
		return result.rows.map((row) => ({ tenantId: row.tenant_id, id: row.id }));
	}

	async claimRun(input: ClaimRunInput): Promise<AdapterRun | null> {
		const result = await this.#write(input.tenantId, (transaction) =>
			transaction.query<RunRow>({
				text: SQL.claimRun,
				parameters: [
					input.tenantId,
					input.id,
					input.claimedBy,
					input.at,
					input.leaseUntil,
				],
			}),
		);
		const row = result.rows[0];
		return row ? runOf(row) : null;
	}

	async heartbeatRun(
		tenantId: string,
		id: string,
		claimedBy: string,
		leaseUntil: number,
	): Promise<boolean> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.heartbeatRun,
				parameters: [tenantId, id, claimedBy, leaseUntil],
			}),
		);
		return result.affectedRows > 0;
	}

	async commitPage(commit: PageCommit): Promise<boolean> {
		return this.#write(commit.tenantId, async (transaction) => {
			const advanced = await transaction.execute({
				text: SQL.advanceRun,
				parameters: [
					commit.tenantId,
					commit.runId,
					commit.claimedBy,
					commit.cursor,
					commit.counts.read,
					commit.counts.created,
					commit.counts.updated,
					commit.counts.skipped,
					commit.counts.failed,
				],
			});
			if (advanced.affectedRows === 0) return false;
			await this.#insertRows(transaction, commit.rows);
			return true;
		});
	}

	async finishRun(input: FinishRunInput): Promise<AdapterRun | null> {
		const result = await this.#write(input.tenantId, (transaction) =>
			transaction.query<RunRow>({
				text: SQL.finishRun,
				parameters: [
					input.tenantId,
					input.runId,
					input.claimedBy,
					input.status,
					input.errorCode,
					input.at,
				],
			}),
		);
		const row = result.rows[0];
		return row ? runOf(row) : null;
	}

	async listDueBindings(
		now: number,
		limit: number,
	): Promise<readonly AdapterDueBinding[]> {
		const result = await this.#handles.background.query<{
			tenant_id: string;
			adapter_id: string;
			next_run_at: Stored;
		}>({ text: SQL.listDueBindings, parameters: [now, limit] });
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			adapterId: row.adapter_id,
			nextRunAt: integer(row.next_run_at, 'timestamp'),
		}));
	}

	async fireSchedule(input: ScheduleFireInput): Promise<ScheduleFireResult> {
		return this.#write(input.tenantId, async (transaction) => {
			const moved = await transaction.query<{ updated_by: string | null }>({
				text: SQL.moveSchedule,
				parameters: [input.tenantId, input.adapterId, input.seen, input.next],
			});
			const binding = moved.rows[0];
			if (!binding) return 'lost';
			if (input.run === null || !input.audit) return 'moved';
			const startedBy = binding.updated_by;
			const run = input.run(startedBy);
			const inserted = await transaction.execute({
				text: SQL.createRun,
				parameters: runParameters(run),
			});
			const queued = inserted.affectedRows > 0;
			await transaction.execute({
				text: SQL.appendAudit,
				parameters: auditParameters(
					queued
						? input.audit('run-started', startedBy, run.id)
						: input.audit('schedule-skipped', startedBy, null),
				),
			});
			return queued ? 'queued' : 'skipped';
		});
	}

	async sweepRuns(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.sweepRuns,
				parameters: [tenantId, cutoff, limit],
			}),
		);
		return result.affectedRows;
	}

	async sweepRunRows(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.sweepRunRows,
				parameters: [tenantId, cutoff, limit],
			}),
		);
		return result.affectedRows;
	}

	async exportRuns(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary> {
		const range = createRange();
		let position: RunPosition = { queuedAt: -1, id: '' };
		for (;;) {
			const result = await this.#read(tenantId, (transaction) =>
				transaction.query<RunRow>({
					text: SQL.exportRuns,
					parameters: [tenantId, position.queuedAt, position.id, EXPORT_PAGE],
				}),
			);
			for (const row of result.rows) {
				const run = runOf(row);
				await sink.write({
					id: run.id,
					adapterId: run.adapterId,
					direction: run.direction,
					status: run.status,
					trigger: run.trigger,
					resumedFrom: run.resumedFrom,
					pages: run.pages,
					rowsRead: run.rowsRead,
					rowsCreated: run.rowsCreated,
					rowsUpdated: run.rowsUpdated,
					rowsSkipped: run.rowsSkipped,
					rowsFailed: run.rowsFailed,
					errorCode: run.errorCode,
					queuedAt: new Date(run.queuedAt).toISOString(),
					startedAt: isoOrNull(run.startedAt),
					finishedAt: isoOrNull(run.finishedAt),
					startedBy: run.startedBy,
				});
				range.observe(run.queuedAt);
				position = { queuedAt: run.queuedAt, id: run.id };
			}
			if (result.rows.length < EXPORT_PAGE) break;
		}
		return range.summary();
	}

	async exportRunRows(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary> {
		let rows = 0;
		let position = { runId: '', rowIndex: 0 };
		for (;;) {
			const result = await this.#read(tenantId, (transaction) =>
				transaction.query<OutcomeRow>({
					text: SQL.exportRunRows,
					parameters: [
						tenantId,
						position.runId,
						position.rowIndex,
						EXPORT_PAGE,
					],
				}),
			);
			for (const row of result.rows) {
				const outcome = outcomeOf(row);
				await sink.write({
					runId: outcome.runId,
					rowIndex: outcome.rowIndex,
					naturalKey: outcome.naturalKey,
					outcome: outcome.outcome,
					errorCode: outcome.errorCode,
					message: outcome.message,
				});
				rows += 1;
				position = { runId: outcome.runId, rowIndex: outcome.rowIndex };
			}
			if (result.rows.length < EXPORT_PAGE) break;
		}
		return { rows, from: null, to: null };
	}

	async exportBindings(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary> {
		const range = createRange();
		let adapterId = '';
		for (;;) {
			const result = await this.#read(tenantId, (transaction) =>
				transaction.query<BindingRow>({
					text: SQL.exportBindings,
					parameters: [tenantId, adapterId, EXPORT_PAGE],
				}),
			);
			for (const row of result.rows) {
				const binding = bindingOf(row);
				await sink.write({
					adapterId: binding.adapterId,
					instanceId: binding.instanceId,
					enabled: binding.enabled,
					mapping: binding.mapping as AdapterJson,
					schedule: binding.schedule,
					nextRunAt: isoOrNull(binding.nextRunAt),
					updatedBy: binding.updatedBy,
					updatedAt: new Date(binding.updatedAt).toISOString(),
				});
				range.observe(binding.updatedAt);
				adapterId = binding.adapterId;
			}
			if (result.rows.length < EXPORT_PAGE) break;
		}
		return range.summary();
	}

	async exportAudit(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary> {
		const range = createRange();
		let position = { occurredAt: -1, id: '' };
		for (;;) {
			const result = await this.#read(tenantId, (transaction) =>
				transaction.query<AuditRow>({
					text: SQL.exportAudit,
					parameters: [tenantId, position.occurredAt, position.id, EXPORT_PAGE],
				}),
			);
			for (const row of result.rows) {
				const event = auditOf(row);
				await sink.write({
					id: event.id,
					adapterId: event.adapterId,
					runId: event.runId,
					action: event.action,
					actorId: event.actorId,
					metadata: event.metadata,
					occurredAt: new Date(event.occurredAt).toISOString(),
				});
				range.observe(event.occurredAt);
				position = { occurredAt: event.occurredAt, id: event.id };
			}
			if (result.rows.length < EXPORT_PAGE) break;
		}
		return range.summary();
	}

	async eraseAccount(
		table: 'runs' | 'bindings' | 'audit',
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: ERASURE[table].erase,
				parameters: [tenantId, accountId, limit],
			}),
		);
		return result.affectedRows;
	}

	async countAccount(
		table: 'runs' | 'bindings' | 'audit',
		tenantId: string,
		accountId: string,
	): Promise<number> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{ rows: Stored }>({
				text: ERASURE[table].count,
				parameters: [tenantId, accountId],
			}),
		);
		return integer(result.rows[0]?.rows ?? 0, 'row count');
	}

	async #insertRows(
		transaction: DatabaseTransaction,
		rows: readonly AdapterRunRow[],
	): Promise<void> {
		for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
			const chunk = rows.slice(start, start + INSERT_CHUNK);
			const values: string[] = [];
			const parameters: Scalar[] = [];
			for (const row of chunk) {
				const base = parameters.length;
				values.push(
					`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},` +
						` $${base + 5}, $${base + 6}, $${base + 7})`,
				);
				parameters.push(
					row.tenantId,
					row.runId,
					row.rowIndex,
					row.naturalKey,
					row.outcome,
					row.errorCode,
					row.message,
				);
			}
			await transaction.execute({
				text:
					`INSERT INTO adapter_run_rows (${ROW_COLUMNS}) VALUES ` +
					`${values.join(', ')}
					 ON CONFLICT (tenant_id, run_id, row_index) DO UPDATE
					 SET natural_key = EXCLUDED.natural_key,
					     outcome = EXCLUDED.outcome,
					     error_code = EXCLUDED.error_code,
					     message = EXCLUDED.message`,
				parameters,
			});
		}
	}
}

function isoOrNull(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

function createRange() {
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	return {
		observe(value: number): void {
			rows += 1;
			const instant = new Date(value);
			if (from === null || instant < from) from = instant;
			if (to === null || instant > to) to = instant;
		},
		summary(): ExportSummary {
			return { rows, from, to };
		},
	};
}
