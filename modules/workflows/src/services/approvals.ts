/* The approvals.core request contract, declared here rather than imported.
   approvals.core is optional: workflows.core composes, publishes and runs
   graphs without a human-approval node when that module is absent, so it is not
   a package dependency. This mirror is the contract approvals.core owns and
   must not drift from it. */
export const APPROVALS_REQUESTS_CAPABILITY = 'approvals.requests.v1';

export type ApprovalStatus =
	| 'pending'
	| 'approved'
	| 'rejected'
	| 'expired'
	| 'cancelled';

export interface ApprovalRequirement {
	readonly roleKey?: string;
	readonly scope?: string;
	readonly decisions?: number;
	readonly expiresInDays?: number;
}

export interface ApprovalRequest {
	readonly id: string;
	readonly tenantId: string;
	readonly subjectModule: string;
	readonly subjectRef: string;
	readonly status: ApprovalStatus;
	readonly expiresAt: number;
	readonly resolvedAt: number | null;
}

export interface OpenApprovalInput {
	readonly tenantId: string;
	readonly subjectModule: string;
	readonly subjectRef: string;
	readonly permission: string;
	readonly action: string;
	readonly title: string;
	readonly summary?: string;
	readonly requesterAccountId: string;
	readonly requirement: ApprovalRequirement;
	readonly onResolved?: (request: ApprovalRequest) => Promise<void>;
}

export interface ApprovalsRequests {
	open(input: OpenApprovalInput): Promise<ApprovalRequest>;
	get(tenantId: string, id: string): Promise<ApprovalRequest | null>;
	cancel(
		tenantId: string,
		id: string,
		actorAccountId: string,
	): Promise<ApprovalRequest>;
}

/* Read at the point of use, never at composition time: the platform may
   register approvals.core after workflows.core, or never. */
export type ApprovalsResolver = () => ApprovalsRequests | null;

/** Roles the workspace defines, for the publish-time requirement check. */
export type WorkspaceRolesResolver = (
	tenantId: string,
) => Promise<readonly string[]>;
