import type { ApprovalRequirement } from '@flowdular/kernel';
import type { ApprovalRequest, ApprovalStatus } from './types.ts';

/**
 * The public cross-module surface. A subject module resolves it through
 * `context.capabilities.get<ApprovalsRequests>(APPROVALS_REQUESTS_CAPABILITY)`
 * and continues without an approval step when it is absent.
 */
export const APPROVALS_REQUESTS_CAPABILITY = 'approvals.requests.v1';

export interface OpenApprovalInput {
	readonly tenantId: string;
	/** The module that owns the record, for example `workflows.core`. */
	readonly subjectModule: string;
	/** Stable reference to that module's record, for example a run and node id. */
	readonly subjectRef: string;
	/** The permission the denied action needed. */
	readonly permission: string;
	/** The domain operation, when one permission covers several. */
	readonly action: string;
	readonly title: string;
	readonly summary?: string;
	readonly requesterAccountId: string;
	readonly requirement: ApprovalRequirement;
	/**
	 * Run once when the request reaches a terminal state, outside the deciding
	 * transaction. It is in-process only: a restart loses it, so a subject
	 * module that must not miss an outcome reads the request back as well.
	 * A callback that throws is logged and never changes the recorded decision.
	 */
	readonly onResolved?: (request: ApprovalRequest) => Promise<void>;
}

export interface ApprovalRequestFilter {
	readonly status?: ApprovalStatus | undefined;
	readonly subjectModule?: string | undefined;
	readonly subjectRef?: string | undefined;
	/** Requests this account opened. */
	readonly requesterAccountId?: string | undefined;
	/** Requests whose eligibility snapshot names this account. */
	readonly decidableBy?: string | undefined;
	readonly limit?: number | undefined;
}

export interface ApprovalsRequests {
	/**
	 * Idempotent on (tenantId, subjectModule, subjectRef) while a request for
	 * that subject is pending: a repeat returns the open request and registers
	 * the new callback against it rather than asking the same question twice.
	 */
	open(input: OpenApprovalInput): Promise<ApprovalRequest>;
	get(tenantId: string, id: string): Promise<ApprovalRequest | null>;
	list(
		tenantId: string,
		filter: ApprovalRequestFilter,
	): Promise<readonly ApprovalRequest[]>;
	/**
	 * Cancels a pending request opened by `actorAccountId`. A member cancelling
	 * somebody else's request goes through the endpoint, which is where
	 * `approvals.requests.manage` is checked.
	 */
	cancel(
		tenantId: string,
		id: string,
		actorAccountId: string,
	): Promise<ApprovalRequest>;
}

/** Longest values the capability accepts; over any of them is a rejection. */
export const APPROVAL_LIMITS = {
	subjectModule: 64,
	subjectRef: 200,
	permission: 96,
	action: 64,
	title: 200,
	summary: 2_000,
	comment: 2_000,
	accountId: 128,
	roleKey: 64,
	scope: 96,
	/** Deciders held in one eligibility snapshot. */
	eligible: 200,
	/** Approvals one requirement may ask for. */
	decisions: 16,
	expiryDays: 90,
	listLimit: 200,
	/** Pending callbacks one process holds before the oldest is dropped. */
	callbacks: 4_096,
} as const;
