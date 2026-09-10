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
	SessionSummary,
	TenantRole,
} from '../domain/types.ts';

export interface AccountCredential {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly displayName: string;
	readonly passwordHash: string;
	readonly role: string;
	readonly roleId: string | null;
	readonly status: 'active' | 'disabled';
	readonly passwordChangeRequired: boolean;
	readonly scopes: readonly string[];
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
	readonly status: 'active' | 'disabled';
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
		secretCiphertext: string,
		createdAt: number,
	): Promise<void>;
	findMfaTotp(accountId: string): Promise<{
		readonly secretCiphertext: string;
		readonly confirmedAt: number | null;
	} | null>;
	confirmMfaTotp(accountId: string, confirmedAt: number): Promise<void>;
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

export class DuplicateRoleKeyError extends Error {
	constructor() {
		super('A role with this key already exists in the workspace.');
		this.name = 'DuplicateRoleKeyError';
	}
}
