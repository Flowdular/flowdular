/**
 * Bounds every report and every input of access.core is checked against. They
 * are declared once here because the endpoint, the service and the screens all
 * have to agree on the same numbers.
 */
export const ACCESS_LIMITS = {
	tenantId: 128,
	accountId: 64,
	label: 254,
	note: 2000,
	/* Rows one review lists per section. The counts beside them stay exact:
	   auth.core answers the whole workspace, so only the listing is capped. */
	members: 500,
	/* Memberships one page of the uncapped member walk answers. The walk is
	   what a file of the review is written from, so this bounds one read and
	   never what reaches the file. */
	memberPage: 200,
	roles: 100,
	tokens: 200,
	providers: 50,
	/** Days one diff or activity window may span. */
	rangeDays: 366,
	/** auth.core answers at most this many audit rows in one page. */
	auditPage: 100,
	/** Audit pages one request may scan before it answers a cursor instead. */
	auditPages: 8,
	reportLimit: 200,
	reportDefault: 50,
	attestationLimit: 100,
	attestationDefault: 25,
	/** Characters of one metadata value carried into a change detail. */
	detailValue: 64,
} as const;

/** Sections of the review whose listing the bounds above can cap. */
export type AccessReviewSection = 'members' | 'roles' | 'tokens' | 'providers';

export interface AccessReviewMember {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly roleId: string | null;
	/** The account across the deployment, which the operator blocks. */
	readonly accountStatus: string;
	/** This workspace's own status for the member. */
	readonly membershipStatus: string;
	readonly scopeCount: number;
	/** Scopes held beyond the ones the assigned role grants. */
	readonly extraScopes: readonly string[];
}

/** One page of the review's memberships, walked by account id. */
export interface AccessReviewMemberPage {
	readonly members: readonly AccessReviewMember[];
	readonly nextCursor: string | null;
}

export interface AccessReviewRole {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly builtin: boolean;
	readonly scopes: readonly string[];
	/** Memberships assigned to this role in the workspace. */
	readonly holders: number;
}

export interface AccessReviewToken {
	readonly id: string;
	readonly label: string;
	/** The public prefix of the token; never a secret or a hash. */
	readonly prefix: string;
	readonly accountId: string;
	/** The holder's e-mail when the account is still a member. */
	readonly accountLabel: string | null;
	readonly scopes: readonly string[];
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly lastUsedAt: number | null;
}

export interface AccessReviewProvider {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly issuer: string;
	readonly status: string;
	/** `platform` for a provider the deployment configured, `tenant` for a workspace's own. */
	readonly scope: string;
	readonly jitEnabled: boolean;
	readonly jitRole: string;
	readonly allowedDomains: readonly string[];
	readonly updatedAt: number;
}

export interface AccessReviewCounts {
	readonly members: number;
	readonly activeMembers: number;
	readonly roles: number;
	/** Member and scope pairs held beyond the assigned role, across the workspace. */
	readonly extraScopeGrants: number;
	readonly tokens: number;
	readonly providers: number;
}

/** Who holds what in one workspace, as it stands at `generatedAt`. */
export interface AccessReview {
	readonly generatedAt: number;
	readonly members: readonly AccessReviewMember[];
	readonly roles: readonly AccessReviewRole[];
	readonly tokens: readonly AccessReviewToken[];
	readonly providers: readonly AccessReviewProvider[];
	readonly counts: AccessReviewCounts;
	/** Sections whose listing hit its bound; their counts are still exact. */
	readonly capped: readonly AccessReviewSection[];
}

export type AccessChangeCategory =
	| 'membership'
	| 'role'
	| 'scope'
	| 'token'
	| 'provider'
	| 'settings'
	| 'security';

/** One recorded change, as the diff and the activity report both carry it. */
export interface AccessChange {
	readonly id: number;
	readonly occurredAt: number;
	readonly category: AccessChangeCategory;
	readonly action: string;
	readonly actor: string;
	readonly actorAccountId: string | null;
	readonly actorKind: string;
	readonly subjectType: string;
	readonly subjectId: string;
	/** A bounded summary of the recorded metadata, or null when it carried none. */
	readonly detail: string | null;
}

/** The reviewed window, echoed so a screen shows what it actually asked for. */
export interface AccessWindow {
	readonly from: number;
	readonly to: number;
}

export interface AccessChangePage {
	readonly items: readonly AccessChange[];
	readonly window: AccessWindow;
	/** Position the next request resumes from, or null once the window is done. */
	readonly next: AuditPosition | null;
}

/** The keyset of one audit event: how both trails and cursors address a row. */
export interface AuditPosition {
	readonly occurredAt: number;
	readonly id: number;
}

export interface AccessAttestation {
	readonly id: string;
	readonly tenantId: string;
	readonly reviewerAccountId: string;
	/** The reviewer's e-mail as it stood, so the evidence survives a rename. */
	readonly reviewerLabel: string;
	readonly periodFrom: string;
	readonly periodTo: string;
	readonly memberCount: number;
	readonly activeMemberCount: number;
	readonly roleCount: number;
	readonly extraScopeCount: number;
	readonly tokenCount: number;
	readonly providerCount: number;
	readonly note: string | null;
	readonly createdAt: number;
}

/** The keyset of one attestation row, which orders by time then identifier. */
export interface AttestationPosition {
	readonly createdAt: number;
	readonly id: string;
}

export interface AttestationPage {
	readonly items: readonly AccessAttestation[];
	readonly next: AttestationPosition | null;
}
