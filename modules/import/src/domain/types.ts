import type { ImportMode } from './ports.ts';

/** The stages a job moves through; the transitions live in the service. */
export const IMPORT_JOB_STATUSES = [
	'parsing',
	'validated',
	'writing',
	'completed',
	'failed',
	'cancelled',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** What one row ended as. The first two are verdicts, the rest are writes. */
export const IMPORT_ROW_OUTCOMES = [
	'valid',
	'invalid',
	'created',
	'updated',
	'skipped',
	'failed',
] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

/** Longest values this module accepts; over any of them is a rejection. */
export const IMPORT_LIMITS = {
	id: 64,
	target: 96,
	documentId: 128,
	accountId: 128,
	field: 64,
	reason: 200,
	recordRef: 200,
	failureCode: 64,
	/** Serialized principal snapshot and column mapping, matching the schema. */
	json: 8_192,
	/** Rows one outcome page may carry; the platform page ceiling. */
	page: 200,
	/** Jobs one routing pass considers. */
	routingPage: 25,
} as const;

/**
 * The CSV bound the spec fixes. It is not a setting: the storage port refuses a
 * larger object at upload, so raising it here would only move the refusal.
 */
export const IMPORT_MAX_CSV_BYTES = 25 * 1024 * 1024;

/**
 * The one content type an import source may carry. The screen uploads under it,
 * the start request refuses anything else, and the stage that opens the file
 * decides the same way, so a document refused at start is never a document a
 * stage goes on to read.
 */
export const IMPORT_CSV_CONTENT_TYPE = 'text/csv';

/**
 * The acting principal as it stood when the job was started, kept so the port
 * sees the same identity in a later stage that it would have seen in the
 * request. Authorization is decided on the live principal at start and at
 * continue; this snapshot carries the decision forward, it does not make one.
 */
export interface ImportRequester {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
}

export interface ImportJob {
	readonly id: string;
	readonly tenantId: string;
	readonly target: string;
	readonly documentId: string;
	/**
	 * The record reference the CSV was uploaded against. documents.core
	 * addresses an attachment by owner module, record reference and id, so the
	 * job carries the reference its `documentId` is only resolvable under.
	 */
	readonly documentRef: string;
	readonly mode: ImportMode;
	readonly dryRun: boolean;
	/** Whether `continue` asked for the valid rows alone. */
	readonly validOnly: boolean;
	readonly status: ImportJobStatus;
	readonly totalRows: number;
	readonly validRows: number;
	readonly writtenRows: number;
	readonly failedRows: number;
	readonly requesterAccountId: string;
	readonly requester: ImportRequester;
	/** Port field id to CSV header, as the job was started with. */
	readonly columns: Readonly<Record<string, string>>;
	/** The stable code behind a failed job; null in every other status. */
	readonly failureCode: string | null;
	readonly claimedAt: number | null;
	readonly startedAt: number;
	readonly completedAt: number | null;
}

/**
 * A job as the poll loop holds it. The claim instant is the fence every renewal
 * of that claim is made under, so a stage can tell that its lease lapsed and the
 * job changed hands.
 */
export type ClaimedImportJob = ImportJob & { readonly claimedAt: number };

/** What a stage records when the failure carries no stable code of its own. */
export const IMPORT_UNEXPECTED_FAILURE = 'JOB_FAILED';

/**
 * The job as an API response carries it. The requester snapshot is bookkeeping
 * a port needs in a background stage and no reader of the screen does, and the
 * claim is the poll loop's own lease, so neither crosses the wire: a job read
 * names the requester by account id alone.
 */
export type ImportJobView = Omit<ImportJob, 'requester' | 'claimedAt'>;

/* Every field is named rather than spread, so a field added to the job is a
   decision taken here instead of an addition the wire makes silently. */
export function importJobView(job: ImportJob): ImportJobView {
	return {
		id: job.id,
		tenantId: job.tenantId,
		target: job.target,
		documentId: job.documentId,
		documentRef: job.documentRef,
		mode: job.mode,
		dryRun: job.dryRun,
		validOnly: job.validOnly,
		status: job.status,
		totalRows: job.totalRows,
		validRows: job.validRows,
		writtenRows: job.writtenRows,
		failedRows: job.failedRows,
		requesterAccountId: job.requesterAccountId,
		columns: job.columns,
		failureCode: job.failureCode,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
	};
}

export interface ImportJobRow {
	readonly id: string;
	readonly tenantId: string;
	readonly jobId: string;
	readonly rowNumber: number;
	readonly outcome: ImportRowOutcome;
	readonly field: string | null;
	readonly reason: string | null;
	readonly recordRef: string | null;
}

export interface ImportMapping {
	readonly id: string;
	readonly tenantId: string;
	readonly target: string;
	readonly columns: Readonly<Record<string, string>>;
	readonly updatedAt: number;
}

/** What the cross-tenant routing read may see, and nothing else. */
export interface ImportJobRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly status: ImportJobStatus;
	readonly startedAt: number;
}
