import type { AccessWindow, AuditPosition } from '../domain/types.ts';

/**
 * Everything access.core reads about who holds what, declared as the narrow
 * shape this module actually needs. auth.core owns the rows; the adapter in
 * auth-directory.ts is the only place that knows that, so the service and its
 * tests never depend on another module's service surface.
 */
export interface DirectoryMember {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly roleId: string | null;
	readonly status: string;
	readonly membershipStatus: string;
	readonly scopes: readonly string[];
}

export interface DirectoryMemberPage {
	readonly members: readonly DirectoryMember[];
	/** The account id the next page walks on from; null on the last page. */
	readonly nextCursor: string | null;
}

export interface DirectoryRole {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly builtin: boolean;
	readonly scopes: readonly string[];
}

export interface DirectoryToken {
	readonly id: string;
	readonly label: string;
	readonly prefix: string;
	readonly accountId: string;
	readonly scopes: readonly string[];
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly lastUsedAt: number | null;
	readonly revokedAt: number | null;
}

export interface DirectoryProvider {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly issuer: string;
	readonly status: string;
	readonly scope: string;
	readonly jitEnabled: boolean;
	readonly jitRole: string;
	readonly allowedDomains: readonly string[];
	readonly updatedAt: number;
}

export interface DirectoryAuditEvent {
	readonly id: number;
	readonly occurredAt: number;
	readonly action: string;
	readonly actorLabel: string;
	readonly actorAccountId: string | null;
	readonly actorKind: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AccessDirectory {
	members(tenantId: string): Promise<readonly DirectoryMember[]>;
	/**
	 * One bounded page of the workspace's memberships, ordered by account id and
	 * starting strictly after `cursor`. A review lists at most its declared bound
	 * and says it was capped; this is what a walk that must carry every member
	 * reads instead, so the size of the workspace decides the number of pages
	 * rather than what reaches the file.
	 */
	memberPage(
		tenantId: string,
		cursor: string | null,
		limit: number,
	): Promise<DirectoryMemberPage>;
	roles(tenantId: string): Promise<readonly DirectoryRole[]>;
	/** Every token of the workspace, revoked ones included. */
	tokens(tenantId: string): Promise<readonly DirectoryToken[]>;
	providers(tenantId: string): Promise<readonly DirectoryProvider[]>;
	/**
	 * At most `limit` recorded events of the inclusive window, newest first and
	 * strictly before `after`. A null `after` starts at the newest event inside
	 * the window. The window is a predicate of the read itself, so an event at
	 * its first or last millisecond is part of the page and nothing outside it
	 * is ever answered.
	 */
	auditPage(
		tenantId: string,
		window: AccessWindow,
		after: AuditPosition | null,
		limit: number,
	): Promise<readonly DirectoryAuditEvent[]>;
}
