import type { DataClassExportSink } from '@flowdular/kernel';
import type {
	AdapterAuditEvent,
	AdapterBinding,
	AdapterDueBinding,
	AdapterRun,
	AdapterRunRouting,
	AdapterRunRow,
} from '../domain/types.ts';

/** The keyset of the last run on a page: newest first, id breaking ties. */
export interface RunPosition {
	readonly queuedAt: number;
	readonly id: string;
}

export interface RunPage {
	readonly items: readonly AdapterRun[];
	readonly next: RunPosition | null;
}

export interface RunRowPage {
	readonly items: readonly AdapterRunRow[];
	readonly next: number | null;
}

export interface ClaimRunInput {
	readonly tenantId: string;
	readonly id: string;
	/** A token unique to this claim; every later write of the stage names it. */
	readonly claimedBy: string;
	readonly at: number;
	readonly leaseUntil: number;
}

export interface RowCounts {
	readonly read: number;
	readonly created: number;
	readonly updated: number;
	readonly skipped: number;
	readonly failed: number;
}

export interface PageCommit {
	readonly tenantId: string;
	readonly runId: string;
	readonly claimedBy: string;
	readonly cursor: string | null;
	readonly rows: readonly AdapterRunRow[];
	readonly counts: RowCounts;
}

export interface FinishRunInput {
	readonly tenantId: string;
	readonly runId: string;
	readonly claimedBy: string;
	readonly status: 'succeeded' | 'failed';
	readonly errorCode: string | null;
	readonly at: number;
}

export interface ScheduleFireInput {
	readonly tenantId: string;
	readonly adapterId: string;
	/** The next time the routing read saw; the compare and swap names it. */
	readonly seen: number;
	readonly next: number | null;
	/**
	 * The run to queue, acting as the account that last saved the binding, and
	 * its event; null only moves the next time, for a schedule that is gone.
	 */
	readonly run: ((startedBy: string | null) => AdapterRun) | null;
	readonly audit?: (
		action: 'run-started' | 'schedule-skipped',
		startedBy: string | null,
		runId: string | null,
	) => AdapterAuditEvent;
}

export type ScheduleFireResult = 'lost' | 'moved' | 'queued' | 'skipped';

export interface ExportSummary {
	readonly rows: number;
	readonly from: Date | null;
	readonly to: Date | null;
}

/**
 * The persistence port: async, database-agnostic and tenant-scoped, except the
 * two routing reads, which cross workspaces on the background role and answer
 * routing columns alone.
 */
export interface AdaptersRepository {
	findBinding(
		tenantId: string,
		adapterId: string,
	): Promise<AdapterBinding | null>;
	listBindings(tenantId: string): Promise<readonly AdapterBinding[]>;
	/** Upserts the binding and appends the events in one transaction. */
	saveBinding(
		binding: AdapterBinding,
		events: readonly AdapterAuditEvent[],
	): Promise<AdapterBinding>;

	/** The most recent run of every adapter of the workspace. */
	latestRuns(tenantId: string): Promise<readonly AdapterRun[]>;
	latestRun(tenantId: string, adapterId: string): Promise<AdapterRun | null>;
	/**
	 * Queues the run and appends the event, or answers false and writes nothing
	 * when a run of the adapter is already queued or running.
	 */
	createRun(run: AdapterRun, event: AdapterAuditEvent): Promise<boolean>;
	findRun(tenantId: string, id: string): Promise<AdapterRun | null>;
	listRuns(
		tenantId: string,
		query: {
			readonly adapterId?: string | undefined;
			readonly limit: number;
			readonly after?: RunPosition | null | undefined;
		},
	): Promise<RunPage>;
	listRunRows(
		tenantId: string,
		runId: string,
		limit: number,
		after?: number | null,
	): Promise<RunRowPage>;
	/** Cancels a queued or running run with its event; null when it was neither. */
	cancelRun(
		tenantId: string,
		id: string,
		at: number,
		event: AdapterAuditEvent,
	): Promise<AdapterRun | null>;

	listPendingRuns(
		now: number,
		limit: number,
	): Promise<readonly AdapterRunRouting[]>;
	claimRun(input: ClaimRunInput): Promise<AdapterRun | null>;
	/** Answers whether the lease of this claim was renewed. */
	heartbeatRun(
		tenantId: string,
		id: string,
		claimedBy: string,
		leaseUntil: number,
	): Promise<boolean>;
	/**
	 * The page's outcomes, the counts and the next cursor in one transaction,
	 * fenced by the claim; false when the run left the claim or was cancelled,
	 * in which case nothing is written.
	 */
	commitPage(commit: PageCommit): Promise<boolean>;
	finishRun(input: FinishRunInput): Promise<AdapterRun | null>;

	listDueBindings(
		now: number,
		limit: number,
	): Promise<readonly AdapterDueBinding[]>;
	fireSchedule(input: ScheduleFireInput): Promise<ScheduleFireResult>;

	sweepRuns(tenantId: string, cutoff: number, limit: number): Promise<number>;
	sweepRunRows(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	exportRuns(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary>;
	exportRunRows(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary>;
	exportBindings(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary>;
	exportAudit(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<ExportSummary>;
	/** Redacts the account from up to `limit` rows; answers how many changed. */
	eraseAccount(
		table: 'runs' | 'bindings' | 'audit',
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	countAccount(
		table: 'runs' | 'bindings' | 'audit',
		tenantId: string,
		accountId: string,
	): Promise<number>;
}
