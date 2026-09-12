/** Per workspace; the account status stays the deployment operator's block. */
export type MembershipStatus = 'active' | 'disabled';

export type IdentityProviderStatus = 'active' | 'disabled';

/**
 * Where an identity provider comes from. A `platform` provider is read from
 * FD_AUTH_OIDC_PROVIDERS at boot and offered to every workspace read-only; a
 * `tenant` provider is a row a workspace owns and administers.
 */
export type IdentityProviderScope = 'platform' | 'tenant';

/** An identity provider as an administrator sees it: never its client secret. */
export interface IdentityProviderSummary {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly scopes: readonly string[];
	readonly jitEnabled: boolean;
	readonly allowedDomains: readonly string[];
	readonly jitRole: string;
	readonly status: IdentityProviderStatus;
	/** Truncated digest of the secret itself; the secret is never readable. */
	readonly secretFingerprint: string;
	readonly scope: IdentityProviderScope;
	readonly updatedAt: number;
}

/** One provider button on the sign-in screen of one workspace. */
export interface SignInProviderOption {
	readonly key: string;
	readonly label: string;
	readonly scope: IdentityProviderScope;
	/** Where the browser starts the authorization request. */
	readonly startPath: string;
}

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
	/** The workspace the screen is on; absent opens the oldest membership. */
	readonly workspace?: string;
}

export interface CreateTenantMemberInput {
	readonly tenantId: string;
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly role: string;
}

/** The same member without a credential; auth.core stores an unusable one. */
export type CreateTenantMemberWithoutPasswordInput = Omit<
	CreateTenantMemberInput,
	'password'
>;

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
	/**
	 * An inclusive epoch-millisecond window over `occurredAt`, applied in SQL
	 * beside the keyset. An absent end is open, so a caller reading a date
	 * window states the window rather than seeding the cursor at its ceiling
	 * and watching for the floor.
	 */
	readonly from?: number | null;
	readonly to?: number | null;
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
