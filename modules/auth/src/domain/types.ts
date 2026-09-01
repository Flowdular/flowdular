export interface AuthTenantAccess {
	readonly tenantId: string;
	readonly name: string;
	readonly slug: string;
	readonly role: string;
}

export interface AuthPrincipal {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly tenants: readonly AuthTenantAccess[];
}

export interface AuthSession {
	readonly principal: AuthPrincipal;
	readonly csrfToken: string;
	readonly expiresAt: number;
	readonly sessionId: string;
	/** Set after an administrative password reset until the account picks a new one. */
	readonly passwordChangeRequired: boolean;
}

export interface IssuedSession extends AuthSession {
	readonly token: string;
}

export interface SignUpInput {
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly organizationName: string;
	readonly organizationSlug: string;
}

export interface SignInInput {
	readonly email: string;
	readonly password: string;
}

export interface CreateTenantMemberInput {
	readonly tenantId: string;
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly role: string;
}

export interface ApiTokenRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly label: string;
	readonly prefix: string;
	readonly scopes: readonly string[];
	readonly createdBy: string;
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly lastUsedAt: number | null;
	readonly revokedAt: number | null;
	readonly revokedBy: string | null;
}

export interface IssuedApiToken {
	readonly record: ApiTokenRecord;
	/* Returned once, at creation. Only its hash is persisted. */
	readonly token: string;
}

export interface CreateApiTokenInput {
	readonly tenantId: string;
	readonly accountId: string;
	readonly label: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number | null;
	readonly createdBy: string;
}

export interface TenantRole {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly scopes: readonly string[];
	readonly builtin: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreateRoleInput {
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly scopes: readonly string[];
}

export interface UpdateRoleInput {
	readonly tenantId: string;
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly scopes?: readonly string[];
}

/* Who performs an administrative change; carried into the audit trail. */
export interface AuthActor {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly role: string;
	readonly scopes: readonly string[];
}

export interface AuditEvent {
	readonly id: number;
	readonly tenantId: string;
	readonly actorAccountId: string | null;
	readonly actorLabel: string;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
}

export interface AuditQuery {
	readonly tenantId: string;
	readonly action?: string | null;
	readonly actor?: string | null;
	readonly limit: number;
	/** `${occurredAt}:${id}` of the last event of the previous page. */
	readonly cursor?: string | null;
}

export interface AuditPage {
	readonly events: readonly AuditEvent[];
	readonly nextCursor: string | null;
}

export interface SessionSummary {
	readonly id: string;
	readonly tenantId: string;
	readonly tenantName: string;
	readonly createdAt: number;
	readonly lastSeenAt: number;
	readonly expiresAt: number;
}
