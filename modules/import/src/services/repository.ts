import type { DataClassExportSink } from '@flowdular/kernel';
import type {
	ClaimedImportJob,
	ImportJob,
	ImportJobRouting,
	ImportJobRow,
	ImportJobStatus,
	ImportMapping,
	ImportRowOutcome,
} from '../domain/types.ts';

export interface ImportJobPage {
	readonly items: readonly ImportJob[];
	readonly nextCursor: JobCursor | null;
}

/** The keyset of the last job on a page: newest first, id breaking ties. */
export interface JobCursor {
	readonly startedAt: number;
	readonly id: string;
}

export interface ImportJobQuery {
	readonly status?: ImportJobStatus | undefined;
	readonly target?: string | undefined;
	readonly limit: number;
	readonly cursor?: JobCursor | undefined;
}

export interface ImportRowPage {
	readonly items: readonly ImportJobRow[];
	readonly nextCursor: number | null;
}

export interface ImportJobResult {
	readonly status: ImportJobStatus;
	readonly totalRows: number;
	readonly validRows: number;
	readonly writtenRows: number;
	readonly failedRows: number;
	readonly failureCode: string | null;
	readonly completedAt: number | null;
}

/** How many rows of one job ended in each outcome; every outcome is present. */
export type ImportRowOutcomeCounts = Readonly<Record<ImportRowOutcome, number>>;

export interface ImportSweepInput {
	/** Settled jobs started strictly before this go, with their outcomes. */
	readonly settledBefore: number;
	/**
	 * A job validated but never continued by this instant is cancelled, so an
	 * abandoned job settles instead of waiting for its retention alone.
	 */
	readonly abandonedBefore: number;
	/** What an expiry records as the job's completion. */
	readonly at: number;
	/** Upper bound on the jobs one pass expires and on the jobs it removes. */
	readonly limit: number;
}

export interface ClaimJobInput {
	readonly tenantId: string;
	readonly id: string;
	readonly claimedAt: number;
	/** A claim at or before this belonged to a process that is gone. */
	readonly staleBefore: number;
}

/**
 * The business port: async, database-agnostic, and unaware of SQL. Every method
 * is tenant-scoped except `listPendingJobs`, which crosses workspaces on the
 * background role and answers routing columns alone.
 */
export interface ImportRepository {
	createJob(job: ImportJob): Promise<ImportJob>;
	findJob(tenantId: string, id: string): Promise<ImportJob | null>;
	listJobs(tenantId: string, query: ImportJobQuery): Promise<ImportJobPage>;
	/** Moves a job between stages; answers null when the status no longer matches. */
	advanceJob(
		tenantId: string,
		id: string,
		from: readonly ImportJobStatus[],
		result: ImportJobResult,
	): Promise<ImportJob | null>;
	/** Records the requester's choice when a validated job is continued. */
	continueJob(
		tenantId: string,
		id: string,
		validOnly: boolean,
	): Promise<ImportJob | null>;
	claimJob(input: ClaimJobInput): Promise<ClaimedImportJob | null>;
	/**
	 * Renews the claim of a job that is still in the stage it was claimed for and
	 * still carries the claim the caller was given, so a stage longer than the
	 * claim lease is not taken up twice and a stage whose lease already lapsed
	 * cannot renew over the loop that reclaimed the job. Answers whether the
	 * renewal landed; a job that left the stage or changed hands is not touched.
	 */
	heartbeatJob(
		tenantId: string,
		id: string,
		at: number,
		claimedAt: number,
	): Promise<boolean>;
	listPendingJobs(limit: number): Promise<readonly ImportJobRouting[]>;

	replaceJobRows(
		tenantId: string,
		jobId: string,
		rows: readonly ImportJobRow[],
	): Promise<void>;
	recordJobRows(tenantId: string, rows: readonly ImportJobRow[]): Promise<void>;
	listJobRows(
		tenantId: string,
		jobId: string,
		limit: number,
		after?: number,
	): Promise<ImportRowPage>;
	/** The row numbers a job called valid, in ascending order. */
	listValidRowNumbers(
		tenantId: string,
		jobId: string,
	): Promise<readonly number[]>;
	/**
	 * The outcomes of one job counted in one read, so a stage that resumed after
	 * a crash reports the whole job rather than the batches it ran itself.
	 */
	countRowOutcomes(
		tenantId: string,
		jobId: string,
	): Promise<ImportRowOutcomeCounts>;

	findMapping(tenantId: string, target: string): Promise<ImportMapping | null>;
	saveMapping(mapping: ImportMapping): Promise<ImportMapping>;

	/**
	 * One retention pass: abandoned validated jobs are cancelled, then settled
	 * jobs older than the cutoff go with their outcomes. Answers how many jobs
	 * were removed.
	 */
	sweepJobs(tenantId: string, input: ImportSweepInput): Promise<number>;
	exportJobs(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<{ rows: number; from: Date | null; to: Date | null }>;
}
