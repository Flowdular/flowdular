/** The stages a job moves through; the transitions live in the service. */
export const EXPORT_JOB_STATUSES = [
	'requested',
	'running',
	'completed',
	'failed',
] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/** Longest values this module accepts; over any of them is a rejection. */
export const EXPORT_LIMITS = {
	id: 64,
	listId: 96,
	accountId: 128,
	objectId: 128,
	failureCode: 64,
	/** Serialized principal snapshot, matching the schema. */
	json: 8_192,
	/** Jobs one page may carry; the platform page ceiling. */
	page: 200,
	/** Jobs one routing pass considers. */
	routingPage: 25,
} as const;

/** What a stage records when the failure carries no stable code of its own. */
export const EXPORT_UNEXPECTED_FAILURE = 'JOB_FAILED';

/**
 * The acting principal as it stood when the job was started, kept so the list
 * sees the same identity in the background stage that it would have seen in the
 * request. Authorization is decided on the live principal at start; this
 * snapshot carries the decision forward, it does not make one.
 */
export interface ExportRequester {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
}

/**
 * One registered list as the catalogue answers it. The permission the list
 * declares is not carried: a reader needs to know whether they may export the
 * list, not the id of the grant that decides it.
 */
export interface ExportListView {
	readonly id: string;
	readonly label: string;
	/** The module that registered the list, so a reader can place it. */
	readonly moduleId: string;
	readonly permitted: boolean;
}

export interface ExportJob {
	readonly id: string;
	readonly tenantId: string;
	readonly listId: string;
	readonly status: ExportJobStatus;
	/** Rows written, the header record excluded. */
	readonly rowCount: number;
	readonly byteCount: number;
	/** The storage object holding the file; null until the job completes. */
	readonly objectId: string | null;
	readonly requesterAccountId: string;
	readonly requester: ExportRequester;
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
export type ClaimedExportJob = ExportJob & { readonly claimedAt: number };

/** What the cross-tenant routing read may see, and nothing else. */
export interface ExportJobRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly status: ExportJobStatus;
	readonly startedAt: number;
}

/**
 * The job as an API response carries it. The requester snapshot is bookkeeping
 * the list needs in a background stage and no reader of the screen does, the
 * claim is the poll loop's own lease, and the object id addresses bytes that
 * are only ever reached through a signed route, so none of the three crosses
 * the wire: a job read names its requester by account id alone.
 */
export type ExportJobView = Omit<
	ExportJob,
	'requester' | 'claimedAt' | 'objectId'
> & {
	/** Whether a file exists to open, without naming where it lives. */
	readonly downloadable: boolean;
};

/* Every field is named rather than spread, so a field added to the job is a
   decision taken here instead of an addition the wire makes silently. */
export function exportJobView(job: ExportJob): ExportJobView {
	return {
		id: job.id,
		tenantId: job.tenantId,
		listId: job.listId,
		status: job.status,
		rowCount: job.rowCount,
		byteCount: job.byteCount,
		requesterAccountId: job.requesterAccountId,
		failureCode: job.failureCode,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
		downloadable: job.objectId !== null,
	};
}
