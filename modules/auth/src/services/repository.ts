import type {
	ActorKind,
	ModuleSettingRecord,
	ModuleSettingValue,
} from '@flowdular/kernel';
import type {
	ApiTokenRecord,
	AuditEvent,
	AuditQuery,
	AuthSession,
	AuthTenantAccess,
	IdentityProviderStatus,
	MembershipStatus,
	SessionSummary,
	TenantRole,
} from '../domain/types.ts';
import type { SealedMfaSecret } from './totp.ts';

export interface AccountCredential {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly displayName: string;
	readonly passwordHash: string;
	readonly role: string;
	readonly roleId: string | null;
	/** The account's platform-level status, set by the deployment operator. */
	readonly status: 'active' | 'disabled';
	/** This workspace's own status for the account. */
	readonly membershipStatus: MembershipStatus;
	readonly passwordChangeRequired: boolean;
	readonly scopes: readonly string[];
}

/** One account, before any workspace is chosen. */
export interface AccountIdentity {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly status: 'active' | 'disabled';
}

export interface CreateAccountRecord {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly normalizedEmail: string;
	readonly passwordHash: string;
	readonly displayName: string;
	readonly organizationName: string;
	readonly organizationSlug: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly createdAt: number;
}

export interface CreateSessionRecord {
	readonly id: string;
	readonly tokenHash: string;
	readonly accountId: string;
	readonly tenantId: string;
	readonly csrfToken: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface PasswordResetTokenRecord {
	readonly tokenHash: string;
	readonly accountId: string;
	readonly expiresAt: number;
	readonly createdAt: number;
}

export interface TenantInvitationRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly email: string;
	readonly normalizedEmail: string;
	readonly roleKey: string;
	readonly tokenHash: string;
	readonly expiresAt: number;
	readonly createdBy: string;
	readonly createdAt: number;
}

export interface MfaChallengeRecord {
	readonly tokenHash: string;
	readonly accountId: string;
	readonly tenantId: string;
	readonly expiresAt: number;
	readonly createdAt: number;
}

/* The identity an external provider asserts. The pair is what the provider
   promises to keep stable; the address it reports may change at any time. A
   tenant-owned provider asserts it inside one workspace, which the row names;
   a platform provider carries none, as it always has. */
export interface ExternalIdentityRecord {
	readonly provider: string;
	readonly subject: string;
	readonly accountId: string;
	readonly tenantId?: string | null;
	readonly now: number;
}

/** A tenant-owned identity provider row, sealed client secret included. */
export interface IdentityProviderRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly label: string;
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint: string;
	readonly clientId: string;
	readonly secretCiphertext: string;
	readonly secretKeyId: string;
	readonly secretFingerprint: string;
	readonly scopes: readonly string[];
	readonly jitEnabled: boolean;
	readonly allowedDomains: readonly string[];
	readonly jitRole: string;
	readonly status: IdentityProviderStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Everything a provider row carries except the columns the row owns itself. */
export type IdentityProviderPatch = Omit<
	IdentityProviderRecord,
	'id' | 'tenantId' | 'key' | 'createdAt' | 'updatedAt'
>;

export interface CreateAccountInTenantRecord {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly normalizedEmail: string;
	readonly passwordHash: string;
	readonly displayName: string;
	readonly role: string;
	readonly roleId: string | null;
	readonly scopes: readonly string[];
	readonly createdAt: number;
}

export interface CreateTenantMembershipRecord {
	readonly accountId: string;
	readonly tenantId: string;
	readonly organizationName: string;
	readonly organizationSlug: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly createdAt: number;
}

export interface CreateApiTokenRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly label: string;
	readonly prefix: string;
	readonly tokenHash: string;
	readonly scopes: readonly string[];
	readonly createdBy: string;
	readonly createdAt: number;
	readonly expiresAt: number | null;
}

export interface TenantMember {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly roleId: string | null;
	/** The account's platform-level status. */
	readonly status: 'active' | 'disabled';
	/** This workspace's own status for the member. */
	readonly membershipStatus: MembershipStatus;
	readonly scopes: readonly string[];
	readonly passwordChangeRequired: boolean;
	readonly createdAt: number;
}

export interface TenantSummary {
	readonly tenantId: string;
	readonly name: string;
	readonly slug: string;
}

export interface SignInFailureRecord {
	readonly failures: number;
	readonly lockedUntil: number | null;
}

export interface CreateRoleRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly scopes: readonly string[];
	readonly builtin: boolean;
	readonly createdAt: number;
}

export interface AuditRecord {
	readonly tenantId: string;
	readonly actorAccountId: string | null;
	readonly actorLabel: string;
	readonly actorKind: ActorKind;
	/* The agent run the entry is traceable to; null for a user. */
	readonly actorRunId: string | null;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
}

/* The audit event plus the actor columns added by 0014. Rows written before it
   read as user actors. */
export interface AuditActorEvent extends AuditEvent {
	readonly actorKind: ActorKind;
	readonly actorRunId: string | null;
}

/**
 * auth.core speaks to one PostgreSQL namespace through two handles: a
 * tenant-scoped runtime handle for everything a workspace owns, and a
 * read-only background handle for the lookups that arrive with a key and no
 * workspace at all. Every method returns a promise because both do.
 */
export interface AuthRepository {
	isTenantSlugTaken(slug: string): Promise<boolean>;
	findTenant(reference: string): Promise<TenantSummary | null>;
	listTenants(): Promise<readonly TenantSummary[]>;
	renameTenant(tenantId: string, name: string): Promise<TenantSummary | null>;
	listOwnerMemberships(): Promise<
		readonly {
			readonly accountId: string;
			readonly tenantId: string;
		}[]
	>;
	findAccountByEmail(
		normalizedEmail: string,
	): Promise<AccountCredential | null>;
	/* The account row alone, without a membership: what an external sign-in
	   needs before it knows whether the workspace already holds the person. */
	findAccountIdentity(normalizedEmail: string): Promise<AccountIdentity | null>;
	findAccountCredentialById(
		accountId: string,
	): Promise<AccountCredential | null>;
	updatePasswordHash(
		accountId: string,
		passwordHash: string,
		changeRequired: boolean,
	): Promise<void>;
	updateAccountDisplayName(
		accountId: string,
		displayName: string,
	): Promise<void>;
	updateAccountStatus(
		accountId: string,
		status: 'active' | 'disabled',
	): Promise<void>;
	deleteAccountSessions(
		accountId: string,
		exceptTokenHash: string | null,
	): Promise<void>;
	deleteMembershipSessions(accountId: string, tenantId: string): Promise<void>;
	deleteMembership(accountId: string, tenantId: string): Promise<boolean>;
	countMemberships(accountId: string): Promise<number>;
	deleteAccount(accountId: string): Promise<void>;
	countActiveOwners(tenantId: string): Promise<number>;
	findAccountMembership(
		accountId: string,
		tenantId: string,
	): Promise<AccountCredential | null>;
	listTenantAccess(accountId: string): Promise<readonly AuthTenantAccess[]>;
	listTenantMembers(tenantId: string): Promise<readonly TenantMember[]>;
	/** One member, for a caller that needs a single account rather than the roll. */
	findTenantMember(
		tenantId: string,
		accountId: string,
	): Promise<TenantMember | null>;
	/**
	 * The members of one workspace whose stored address is in the list. The
	 * caller normalizes and bounds the list; the comparison is against
	 * `email_normalized`, which is the same folded form.
	 */
	findTenantMembersByEmail(
		tenantId: string,
		normalizedEmails: readonly string[],
	): Promise<readonly TenantMember[]>;
	/**
	 * The members of one workspace whose display name contains `term` or whose
	 * address starts with it, ordered as `listTenantMembers` orders and cut to
	 * `limit` in the database. `term` arrives already folded and LIKE-escaped.
	 */
	searchTenantMembers(
		tenantId: string,
		term: string,
		limit: number,
	): Promise<readonly TenantMember[]>;
	listTenantScopes(tenantId: string): Promise<readonly string[]>;
	createAccountWithTenant(
		record: CreateAccountRecord,
	): Promise<AccountCredential>;
	createAccountInTenant(
		record: CreateAccountInTenantRecord,
	): Promise<AccountCredential>;
	createTenantMembership(
		record: CreateTenantMembershipRecord,
	): Promise<AccountCredential>;
	createMembershipInTenant(record: {
		readonly accountId: string;
		readonly tenantId: string;
		readonly role: string;
		readonly roleId: string | null;
		readonly scopes: readonly string[];
		readonly createdAt: number;
	}): Promise<AccountCredential>;
	createApiToken(record: CreateApiTokenRecord): Promise<ApiTokenRecord>;
	listApiTokens(tenantId: string): Promise<readonly ApiTokenRecord[]>;
	findApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
	/* The tenant comes from the record the lookup already returned, so touching
	   a token costs no second cross-tenant read. */
	touchApiToken(tenantId: string, id: string, usedAt: number): Promise<void>;
	revokeApiToken(
		tenantId: string,
		id: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<ApiTokenRecord | null>;
	insertMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<void>;
	/** Atomically extends the built-in owner role and current owners of one tenant.
	 * Returns only membership scopes inserted by this call. */
	grantTenantOwnerScopes(
		tenantId: string,
		scopes: readonly string[],
		updatedAt: number,
	): Promise<
		readonly {
			readonly accountId: string;
			readonly granted: readonly string[];
		}[]
	>;
	replaceMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<void>;
	updateMembershipRole(
		accountId: string,
		tenantId: string,
		role: string,
		roleId: string | null,
		scopes: readonly string[],
	): Promise<void>;
	createSession(record: CreateSessionRecord): Promise<void>;
	/* A read older than idleMs since the last touch resolves to null; a
	   successful read refreshes last_seen_at at most once per touchIntervalMs. */
	findSession(
		tokenHash: string,
		now: number,
		idleMs: number,
		touchIntervalMs: number,
	): Promise<AuthSession | null>;
	listAccountSessions(
		accountId: string,
		now: number,
	): Promise<readonly SessionSummary[]>;
	deleteSession(tokenHash: string): Promise<void>;
	deleteSessionById(accountId: string, id: string): Promise<boolean>;
	deleteExpiredSessions(now: number): Promise<number>;
	createPasswordResetToken(record: PasswordResetTokenRecord): Promise<void>;
	/** The account a live token names, without spending it. */
	findPasswordResetTokenAccount(
		tokenHash: string,
		now: number,
	): Promise<string | null>;
	consumePasswordResetToken(
		tokenHash: string,
		now: number,
	): Promise<string | null>;
	createTenantInvitation(record: TenantInvitationRecord): Promise<void>;
	consumeTenantInvitation(
		tokenHash: string,
		now: number,
	): Promise<{
		readonly tenantId: string;
		readonly email: string;
		readonly normalizedEmail: string;
		readonly roleKey: string;
	} | null>;
	upsertMfaTotp(
		accountId: string,
		secret: SealedMfaSecret,
		createdAt: number,
	): Promise<void>;
	findMfaTotp(accountId: string): Promise<{
		readonly secretCiphertext: string;
		/* Null on a row sealed before 0017 added the column; the ring opens it by
		   trying every key it holds. */
		readonly keyId: string | null;
		readonly confirmedAt: number | null;
	} | null>;
	/* Answers the enrolment question without reading the enrolled secret, which
	   an authorization decision has no reason to hold. */
	hasConfirmedMfaTotp(accountId: string): Promise<boolean>;
	confirmMfaTotp(accountId: string, confirmedAt: number): Promise<void>;
	/* Removes the factor and every recovery code together, so an administrative
	   reset can never leave a code redeemable for a secret that is gone. */
	deleteMfaEnrolment(accountId: string): Promise<void>;
	replaceMfaRecoveryCodes(
		accountId: string,
		codeHashes: readonly string[],
		createdAt: number,
	): Promise<void>;
	consumeMfaRecoveryCode(accountId: string, codeHash: string): Promise<boolean>;
	createMfaChallenge(record: MfaChallengeRecord): Promise<void>;
	consumeMfaChallenge(
		tokenHash: string,
		now: number,
	): Promise<{
		readonly accountId: string;
		readonly tenantId: string;
	} | null>;
	/* `tenantId` selects the binding space: null is the platform space a
	   provider from the environment binds in, a workspace id is that
	   workspace's own space. */
	findExternalIdentity(
		provider: string,
		subject: string,
		tenantId?: string | null,
	): Promise<string | null>;
	findExternalIdentitySubject(
		provider: string,
		accountId: string,
		tenantId?: string | null,
	): Promise<string | null>;
	linkExternalIdentity(record: ExternalIdentityRecord): Promise<void>;
	deleteExternalIdentitiesOfProvider(
		tenantId: string,
		provider: string,
	): Promise<void>;
	listIdentityProviders(
		tenantId: string,
	): Promise<readonly IdentityProviderRecord[]>;
	findIdentityProvider(
		tenantId: string,
		id: string,
	): Promise<IdentityProviderRecord | null>;
	findIdentityProviderByKey(
		tenantId: string,
		key: string,
	): Promise<IdentityProviderRecord | null>;
	createIdentityProvider(
		record: IdentityProviderRecord,
	): Promise<IdentityProviderRecord>;
	updateIdentityProvider(
		tenantId: string,
		id: string,
		patch: IdentityProviderPatch,
		updatedAt: number,
	): Promise<IdentityProviderRecord | null>;
	deleteIdentityProvider(tenantId: string, id: string): Promise<boolean>;
	/** Revokes the membership's live tokens; a revoked one stays revoked. */
	revokeMembershipApiTokens(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<number>;
	setMembershipStatus(
		accountId: string,
		tenantId: string,
		status: MembershipStatus,
	): Promise<boolean>;
	findSignInFailure(
		normalizedEmail: string,
	): Promise<SignInFailureRecord | null>;
	recordSignInFailure(
		normalizedEmail: string,
		now: number,
		lockThreshold: number,
		lockMs: number,
		retentionMs: number,
	): Promise<SignInFailureRecord>;
	clearSignInFailures(normalizedEmail: string): Promise<void>;
	listRoles(tenantId: string): Promise<readonly TenantRole[]>;
	findRole(tenantId: string, id: string): Promise<TenantRole | null>;
	findRoleByKey(tenantId: string, key: string): Promise<TenantRole | null>;
	createRole(record: CreateRoleRecord): Promise<TenantRole>;
	updateRole(
		tenantId: string,
		id: string,
		patch: {
			readonly name: string;
			readonly description: string;
			readonly scopes: readonly string[];
		},
		updatedAt: number,
	): Promise<TenantRole | null>;
	deleteRole(tenantId: string, id: string): Promise<boolean>;
	countRoleMemberships(tenantId: string, roleId: string): Promise<number>;
	appendAudit(record: AuditRecord): Promise<void>;
	queryAudit(query: AuditQuery): Promise<readonly AuditActorEvent[]>;
	/* The data class operations. Every page is a keyset read of one workspace,
	   every sweep a bounded delete of rows a workspace no longer needs; the
	   caller decides the cutoff from the workspace's retention period. */
	exportSessionsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly SessionExportRecord[]>;
	/** Removes sessions that expired before `before`; a live one is never touched. */
	deleteSessionsExpiredBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	exportApiTokensPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly ApiTokenRecord[]>;
	/** Removes tokens that were revoked or expired before `before`; a usable one stays. */
	deleteApiTokensRetiredBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	exportAuditEventsPage(
		tenantId: string,
		afterId: number,
		limit: number,
	): Promise<readonly AuditEvent[]>;
	deleteAuditEventsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	/* The erasure operations. Each removes at most `limit` rows one account owns
	   inside one workspace, so a subject erased in one workspace keeps what
	   another workspace holds about them. */
	deleteMembershipSessionsOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	deleteMembershipApiTokensOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	/* The stored module settings of one tenant and module. The synchronous
	   kernel ModuleSettingsStore is served from a snapshot over these three;
	   see services/settings-store.ts. */
	loadSettings(
		tenantId: string,
		moduleId: string,
	): Promise<Readonly<Record<string, ModuleSettingValue>>>;
	saveSetting(record: ModuleSettingRecord): Promise<void>;
	clearSetting(tenantId: string, moduleId: string, key: string): Promise<void>;
}

/* What a session export carries. It names no secret: a session is known by its
   id, and the hash that authenticates it stays in the database. An API token
   export carries ApiTokenRecord, which already omits the hash. */
export interface SessionExportRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly lastSeenAt: number;
}

export class DuplicateAccountError extends Error {
	constructor() {
		super('An account with this email already exists.');
		this.name = 'DuplicateAccountError';
	}
}

export class DuplicateTenantSlugError extends Error {
	constructor() {
		super('A workspace with this id already exists.');
		this.name = 'DuplicateTenantSlugError';
	}
}

export class DuplicateProviderKeyError extends Error {
	constructor() {
		super('A provider with this key already exists in the workspace.');
		this.name = 'DuplicateProviderKeyError';
	}
}

export class DuplicateRoleKeyError extends Error {
	constructor() {
		super('A role with this key already exists in the workspace.');
		this.name = 'DuplicateRoleKeyError';
	}
}
