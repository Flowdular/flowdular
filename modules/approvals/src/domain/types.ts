/** Every state a request can hold. Only `pending` accepts a decision. */
export const APPROVAL_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'expired',
	'cancelled',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TERMINAL_APPROVAL_STATUSES = [
	'approved',
	'rejected',
	'expired',
	'cancelled',
] as const;

export type TerminalApprovalStatus =
	(typeof TERMINAL_APPROVAL_STATUSES)[number];

/** Every row the append-only ledger can carry. */
export const APPROVAL_DECISIONS = [
	'approve',
	'reject',
	'expire',
	'cancel',
] as const;

export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

/**
 * One pending or resolved question of whether an action on a record may go
 * ahead. The eligibility snapshot is not part of it: who may decide is answered
 * by the snapshot rows behind `decidableBy`, and re-answered against live
 * membership when a decision arrives.
 */
export interface ApprovalRequest {
	readonly id: string;
	readonly tenantId: string;
	readonly subjectModule: string;
	readonly subjectRef: string;
	readonly permission: string;
	readonly action: string;
	readonly title: string;
	readonly summary: string | null;
	readonly requesterAccountId: string;
	readonly requirement: ApprovalRequirementRecord;
	readonly decisionsNeeded: number;
	readonly status: ApprovalStatus;
	readonly expiresAt: number;
	readonly resolvedAt: number | null;
	readonly createdAt: number;
}

/**
 * The requirement as it was opened. It mirrors the kernel `ApprovalRequirement`
 * with the two optional fields resolved, so a stored row never has to be read
 * back through a partially specified shape.
 */
export interface ApprovalRequirementRecord {
	readonly roleKey: string | null;
	readonly scope: string | null;
	readonly decisions: number;
	readonly expiresInDays: number;
}

export interface ApprovalDecision {
	readonly id: string;
	readonly tenantId: string;
	readonly requestId: string;
	/** Null for the expiry loop, which is the one decision no member makes. */
	readonly deciderAccountId: string | null;
	readonly decision: ApprovalDecisionKind;
	readonly comment: string | null;
	readonly decidedAt: number;
}

/** What an erasure writes over the comment of a decision it keeps. */
export const ERASED_DECISION_COMMENT = '[erased]';

/**
 * Prefix of the account an erasure writes over a decision or an eligibility row
 * it keeps. Something unique to the row follows it, because both tables are
 * unique per request and account: one fixed value would collide the moment two
 * erased subjects had answered, or been eligible for, the same request, and the
 * erasure would fail instead of clearing either of them.
 */
export const ERASED_ACCOUNT_PREFIX = 'erased:';

/** A request with its ledger, as the drawer and the read endpoints return it. */
export interface ApprovalRequestDetail {
	readonly request: ApprovalRequest;
	readonly decisions: readonly ApprovalDecision[];
}

/**
 * What the member reading a request may do with it, answered by the server so a
 * screen never has to guess at eligibility it cannot see.
 */
export interface ApprovalViewerRights {
	readonly accountId: string;
	readonly canDecide: boolean;
	readonly canCancel: boolean;
}

export interface ApprovalRequestView extends ApprovalRequestDetail {
	readonly viewer: ApprovalViewerRights;
}

/** What the cross-tenant expiry poll is allowed to learn. */
export interface ApprovalRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly expiresAt: number;
	readonly status: ApprovalStatus;
}

/** A workspace member as eligibility is resolved against it. */
export interface ApprovalMember {
	readonly accountId: string;
	readonly roleKey: string;
	readonly scopes: readonly string[];
}

export function isTerminalApprovalStatus(
	status: ApprovalStatus,
): status is TerminalApprovalStatus {
	return status !== 'pending';
}
