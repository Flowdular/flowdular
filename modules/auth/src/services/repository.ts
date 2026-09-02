import type { ActorKind, ModuleSettingsStore } from '@coreloom/kernel';
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

export interface AuthRepository extends ModuleSettingsStore {
	isTenantSlugTaken(slug: string): boolean;
	findTenant(reference: string): TenantSummary | null;
	listTenants(): readonly TenantSummary[];
	renameTenant(tenantId: string, name: string): TenantSummary | null;
	listOwnerMemberships(): readonly {
		readonly accountId: string;
		readonly tenantId: string;
	}[];
	findAccountByEmail(normalizedEmail: string): AccountCredential | null;
	findAccountCredentialById(accountId: string): AccountCredential | null;
	updatePasswordHash(
		accountId: string,
		passwordHash: string,
		changeRequired: boolean,
	): void;
	updateAccountDisplayName(accountId: string, displayName: string): void;
	updateAccountStatus(accountId: string, status: 'active' | 'disabled'): void;
	deleteAccountSessions(
		accountId: string,
		exceptTokenHash: string | null,
	): void;
	deleteMembershipSessions(accountId: string, tenantId: string): void;
	deleteMembership(accountId: string, tenantId: string): boolean;
	countMemberships(accountId: string): number;
	deleteAccount(accountId: string): void;
	countActiveOwners(tenantId: string): number;
	findAccountMembership(
		accountId: string,
		tenantId: string,
	): AccountCredential | null;
	listTenantAccess(accountId: string): readonly AuthTenantAccess[];
	listTenantMembers(tenantId: string): readonly TenantMember[];
	listTenantScopes(tenantId: string): readonly string[];
	createAccountWithTenant(record: CreateAccountRecord): AccountCredential;
	createAccountInTenant(record: CreateAccountInTenantRecord): AccountCredential;
	createTenantMembership(
		record: CreateTenantMembershipRecord,
	): AccountCredential;
	createMembershipInTenant(record: {
		readonly accountId: string;
		readonly tenantId: string;
		readonly role: string;
		readonly roleId: string | null;
		readonly scopes: readonly string[];
		readonly createdAt: number;
	}): AccountCredential;
	createApiToken(record: CreateApiTokenRecord): ApiTokenRecord;
	listApiTokens(tenantId: string): readonly ApiTokenRecord[];
	findApiTokenByHash(tokenHash: string): ApiTokenRecord | null;
	touchApiToken(id: string, usedAt: number): void;
	revokeApiToken(
		tenantId: string,
		id: string,
		revokedAt: number,
		revokedBy: string,
	): ApiTokenRecord | null;
	insertMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): void;
	replaceMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): void;
	updateMembershipRole(
		accountId: string,
		tenantId: string,
		role: string,
		roleId: string | null,
		scopes: readonly string[],
	): void;
	createSession(record: CreateSessionRecord): void;
	/* A read older than idleMs since the last touch resolves to null; a
	   successful read refreshes last_seen_at at most once per touchIntervalMs. */
	findSession(
		tokenHash: string,
		now: number,
		idleMs: number,
		touchIntervalMs: number,
	): AuthSession | null;
	listAccountSessions(
		accountId: string,
		now: number,
	): readonly SessionSummary[];
	deleteSession(tokenHash: string): void;
	deleteSessionById(accountId: string, id: string): boolean;
	deleteExpiredSessions(now: number): number;
	createPasswordResetToken(record: PasswordResetTokenRecord): void;
	consumePasswordResetToken(tokenHash: string, now: number): string | null;
	createTenantInvitation(record: TenantInvitationRecord): void;
	consumeTenantInvitation(
		tokenHash: string,
		now: number,
	): {
		readonly tenantId: string;
		readonly email: string;
		readonly normalizedEmail: string;
		readonly roleKey: string;
	} | null;
	upsertMfaTotp(
		accountId: string,
		secretCiphertext: string,
		createdAt: number,
	): void;
	findMfaTotp(accountId: string): {
		readonly secretCiphertext: string;
		readonly confirmedAt: number | null;
	} | null;
	confirmMfaTotp(accountId: string, confirmedAt: number): void;
	replaceMfaRecoveryCodes(
		accountId: string,
		codeHashes: readonly string[],
		createdAt: number,
	): void;
	consumeMfaRecoveryCode(accountId: string, codeHash: string): boolean;
	createMfaChallenge(record: MfaChallengeRecord): void;
	consumeMfaChallenge(
		tokenHash: string,
		now: number,
	): { readonly accountId: string; readonly tenantId: string } | null;
	findSignInFailure(normalizedEmail: string): SignInFailureRecord | null;
	recordSignInFailure(
		normalizedEmail: string,
		now: number,
		lockThreshold: number,
		lockMs: number,
		retentionMs: number,
	): SignInFailureRecord;
	clearSignInFailures(normalizedEmail: string): void;
	listRoles(tenantId: string): readonly TenantRole[];
	findRole(tenantId: string, id: string): TenantRole | null;
	findRoleByKey(tenantId: string, key: string): TenantRole | null;
	createRole(record: CreateRoleRecord): TenantRole;
	updateRole(
		tenantId: string,
		id: string,
		patch: {
			readonly name: string;
			readonly description: string;
			readonly scopes: readonly string[];
		},
		updatedAt: number,
	): TenantRole | null;
	deleteRole(tenantId: string, id: string): boolean;
	countRoleMemberships(tenantId: string, roleId: string): number;
	appendAudit(record: AuditRecord): void;
	queryAudit(query: AuditQuery): readonly AuditActorEvent[];
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
