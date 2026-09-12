import type {
	ApprovalDecision,
	ApprovalRequest,
	ApprovalRequestDetail,
	ApprovalRouting,
	ApprovalStatus,
	TerminalApprovalStatus,
} from '../domain/types.ts';

export interface ApprovalRequestFilters {
	readonly status?: ApprovalStatus | undefined;
	readonly subjectModule?: string | undefined;
	readonly subjectRef?: string | undefined;
	readonly requesterAccountId?: string | undefined;
	/** Requests whose eligibility snapshot names this account. */
	readonly decidableBy?: string | undefined;
}

export interface CreateApprovalResult {
	readonly request: ApprovalRequest;
	/** False when a pending request for the same subject already existed. */
	readonly created: boolean;
}

/**
 * One decision, written in a single tenant-scoped write transaction. `resolve`
 * is pure and receives every decision recorded on the request including this
 * one: the service owns when a request resolves, the adapter owns the
 * transaction the count is taken in.
 */
export interface DecideApprovalInput {
	readonly tenantId: string;
	readonly requestId: string;
	readonly decision: ApprovalDecision;
	readonly resolve: (
		decisions: readonly ApprovalDecision[],
	) => TerminalApprovalStatus | null;
	readonly resolvedAt: number;
}

export type DecideApprovalResult =
	| {
			readonly outcome: 'recorded';
			readonly request: ApprovalRequest;
			readonly decisions: readonly ApprovalDecision[];
			readonly resolved: boolean;
	  }
	/** The request left `pending` before this decision reached it. */
	| { readonly outcome: 'not-pending'; readonly request: ApprovalRequest }
	/** This account already approved or rejected this request. */
	| { readonly outcome: 'duplicate'; readonly request: ApprovalRequest }
	| { readonly outcome: 'not-found' };

/**
 * The persistence port. Async and database agnostic: the PostgreSQL statements,
 * the tenant transactions and the background lease live in the adapter.
 */
export interface ApprovalsRepository {
	/**
	 * Idempotent while a request for the same subject is pending: a repeat
	 * writes nothing and answers with the open request and `created: false`.
	 */
	create(
		request: ApprovalRequest,
		eligibleAccountIds: readonly string[],
	): Promise<CreateApprovalResult>;
	get(tenantId: string, id: string): Promise<ApprovalRequest | null>;
	/**
	 * The one request still asking about this subject, read on the unique index
	 * that makes opening idempotent.
	 */
	findPendingBySubject(
		tenantId: string,
		subjectModule: string,
		subjectRef: string,
	): Promise<ApprovalRequest | null>;
	detail(tenantId: string, id: string): Promise<ApprovalRequestDetail | null>;
	list(
		tenantId: string,
		filters: ApprovalRequestFilters,
		limit: number,
	): Promise<readonly ApprovalRequest[]>;
	/** Whether the snapshot taken when the request opened names this account. */
	isSnapshotDecider(
		tenantId: string,
		requestId: string,
		accountId: string,
	): Promise<boolean>;
	/** Pending requests this account is in the eligibility snapshot of. */
	countDecidable(tenantId: string, accountId: string): Promise<number>;
	decide(input: DecideApprovalInput): Promise<DecideApprovalResult>;
	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listDueExpiries(
		now: number,
		limit: number,
	): Promise<readonly ApprovalRouting[]>;

	/* The operations behind the declared data class. Each runs on this module's
	   own lease, inside its own tenant-scoped transaction, in bounded batches. */

	/**
	 * Keyset page of the workspace's requests with their ledgers, ordered by id.
	 * `afterId` is the id of the last request the previous page carried.
	 */
	exportRequestsPage(
		tenantId: string,
		afterId: string | null,
		limit: number,
	): Promise<readonly ApprovalRequestDetail[]>;
	/**
	 * Removes at most `limit` requests resolved strictly before `before`, with
	 * their eligibility and decision rows. A pending request is never taken.
	 */
	deleteResolvedBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	/**
	 * Removes at most `limit` resolved requests this account opened, with their
	 * eligibility and decision rows.
	 */
	deleteResolvedRequestedBy(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	/**
	 * Redacts at most `limit` decisions this account recorded, keeping the rows:
	 * the comment becomes a fixed marker and the account a per-row tombstone.
	 */
	redactDecisionsBy(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	/**
	 * Redacts at most `limit` eligibility rows naming this account, in requests
	 * pending as well as resolved, keeping the rows so a snapshot goes on
	 * reporting how many people could answer. The other deciders are untouched.
	 */
	redactEligibilityOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	/** Requests this account opened, in any state. */
	countRequestedBy(tenantId: string, accountId: string): Promise<number>;
}
