import type {
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type {
	ClaimedExportJob,
	ExportJob,
	ExportJobRouting,
	ExportJobStatus,
} from '../domain/types.ts';

/** The keyset of the last job on a page: newest first, id breaking ties. */
export interface ExportJobCursor {
	readonly startedAt: number;
	readonly id: string;
}

export interface ExportJobQuery {
	readonly status?: ExportJobStatus | undefined;
	readonly limit: number;
	readonly cursor?: ExportJobCursor | undefined;
}

export interface ExportJobPage {
	readonly items: readonly ExportJob[];
	readonly nextCursor: ExportJobCursor | null;
}

export interface ClaimExportJobInput {
	readonly tenantId: string;
	readonly id: string;
	readonly claimedAt: number;
	/** A claim at or before this belonged to a process that is gone. */
	readonly staleBefore: number;
}

export interface SettleExportJobInput {
	readonly status: Extract<ExportJobStatus, 'completed' | 'failed'>;
	readonly rowCount: number;
	readonly byteCount: number;
	readonly objectId: string | null;
	readonly failureCode: string | null;
	readonly completedAt: number;
}

export interface ExportSweepInput {
	/** Settled jobs started strictly before this go. */
	readonly settledBefore: number;
	/** Upper bound on the jobs one pass removes. */
	readonly limit: number;
}

export interface ExportSweepBatch {
	readonly ids: readonly string[];
	/** The objects those jobs hold, for the caller to delete before the rows. */
	readonly objectIds: readonly string[];
}

/**
 * The business port: async, database-agnostic, and unaware of SQL. Every method
 * is tenant-scoped except `listPendingJobs`, which crosses workspaces on the
 * background role and answers routing columns alone.
 */
export interface ExportRepository {
	createJob(job: ExportJob): Promise<ExportJob>;
	findJob(tenantId: string, id: string): Promise<ExportJob | null>;
	listJobs(tenantId: string, query: ExportJobQuery): Promise<ExportJobPage>;
	/** Routing columns of the jobs waiting or in flight, across workspaces. */
	listPendingJobs(limit: number): Promise<readonly ExportJobRouting[]>;
	/** Takes one job for this process; null when another already holds it. */
	claimJob(input: ClaimExportJobInput): Promise<ClaimedExportJob | null>;
	/** Renews a claim, answering false once the job changed hands. */
	heartbeatJob(
		tenantId: string,
		id: string,
		at: number,
		claimedAt: number,
	): Promise<boolean>;
	/** Settles a running job; null when it is no longer this process's work. */
	settleJob(
		tenantId: string,
		id: string,
		input: SettleExportJobInput,
	): Promise<ExportJob | null>;
	/** The batch one retention pass removes, chosen once, oldest first. */
	claimSweepBatch(
		tenantId: string,
		input: ExportSweepInput,
	): Promise<ExportSweepBatch>;
	/** Removes the jobs of a chosen batch; answers how many rows went. */
	deleteJobs(tenantId: string, ids: readonly string[]): Promise<number>;
	/** The whole workspace, oldest first, for the data class export. */
	exportJobs(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary>;
}
