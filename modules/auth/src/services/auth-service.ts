import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AUTH_SCOPES, MEMBER_SCOPES, OWNER_SCOPES } from '../acl/scopes.ts';
import type {
	ApiTokenRecord,
	AuditPage,
	AuditQuery,
	AuthActor,
	AuthPrincipal,
	AuthSession,
	AuthTenantAccess,
	CreateApiTokenInput,
	CreateRoleInput,
	CreateTenantMemberInput,
	IssuedApiToken,
	IssuedSession,
	SessionSummary,
	SignInInput,
	SignUpInput,
	TenantRole,
	UpdateRoleInput,
} from '../domain/types.ts';
import {
	DEFAULT_PASSWORD_MIN_LENGTH,
	DEFAULT_SESSION_IDLE_MINUTES,
	DEFAULT_SESSION_TTL_HOURS,
} from '../settings.ts';
import { AuthServiceError } from './auth-service-error.ts';
import {
	DEFAULT_PASSWORD_HASH_OPTIONS,
	hashPassword,
	verifyPassword,
	type PasswordHashOptions,
} from './password.ts';
import {
	DuplicateAccountError,
	DuplicateRoleKeyError,
	DuplicateTenantSlugError,
	type AccountCredential,
	type AuthRepository,
	type TenantMember,
	type TenantSummary,
} from './repository.ts';
import {
	assertPasswordPolicy,
	normalizeEmail,
	validateCreateTenantMember,
	validateDisplayName,
	validateRoleDescription,
	validateRoleKey,
	validateRoleName,
	validateSignIn,
	validateSignUp,
	validateWorkspaceName,
	validateWorkspaceSlug,
} from './validation.ts';

export interface AuthPolicy {
	readonly sessionTtlMs: number;
	readonly sessionIdleMs: number;
	readonly passwordMinLength: number;
}

export interface AuthServiceOptions {
	readonly sessionTtlMs?: number;
	/** Live policy; read on every call so settings changes apply immediately. */
	readonly policy?: () => AuthPolicy;
	readonly passwordHash?: PasswordHashOptions;
	readonly now?: () => number;
}

export interface SignInContext {
	/** Client address when known; null skips address-based limits. */
	readonly address?: string | null;
}

export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export const API_TOKEN_PREFIX = 'clat_';
const API_TOKEN_PATTERN = /^clat_[A-Za-z0-9_-]{43}$/;
const MAX_API_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const API_TOKEN_TOUCH_INTERVAL_MS = 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60 * 1000;
const FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_AUDIT_PAGE = 100;

export const AUDIT_ACTIONS = Object.freeze({
	signInSucceeded: 'auth.sign-in.succeeded',
	signInFailed: 'auth.sign-in.failed',
	signInLocked: 'auth.sign-in.locked',
	signOut: 'auth.sign-out',
	sessionRevoked: 'auth.session.revoked',
	passwordChanged: 'auth.password.changed',
	tokenIssued: 'auth.token.issued',
	tokenRevoked: 'auth.token.revoked',
	tenantRenamed: 'auth.tenant.renamed',
	memberCreated: 'users.member.created',
	memberUpdated: 'users.member.updated',
	memberStatus: 'users.member.status',
	memberRemoved: 'users.member.removed',
	memberPasswordReset: 'users.member.password-reset',
	memberScopes: 'users.member.scopes',
	memberRole: 'users.member.role',
	roleCreated: 'auth.role.created',
	roleUpdated: 'auth.role.updated',
	roleDeleted: 'auth.role.deleted',
	settingsUpdated: 'settings.updated',
});

export const AUDIT_ACTION_LIST = Object.freeze(Object.values(AUDIT_ACTIONS));

function member(account: AccountCredential, createdAt: number): TenantMember {
	return {
		accountId: account.accountId,
		email: account.email,
		displayName: account.displayName,
		role: account.role,
		roleId: account.roleId,
		status: account.status,
		scopes: account.scopes,
		passwordChangeRequired: account.passwordChangeRequired,
		createdAt,
	};
}

export class AuthService {
	readonly #repository: AuthRepository;
	readonly #policy: () => AuthPolicy;
	readonly #passwordHash: PasswordHashOptions;
	readonly #now: () => number;

	constructor(repository: AuthRepository, options: AuthServiceOptions = {}) {
		this.#repository = repository;
		const fallback: AuthPolicy = {
			sessionTtlMs:
				options.sessionTtlMs ?? DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000,
			sessionIdleMs: DEFAULT_SESSION_IDLE_MINUTES * 60 * 1000,
			passwordMinLength: DEFAULT_PASSWORD_MIN_LENGTH,
		};
		this.#policy = options.policy ?? (() => fallback);
		this.#passwordHash = options.passwordHash ?? DEFAULT_PASSWORD_HASH_OPTIONS;
		this.#now = options.now ?? Date.now;
	}

	get policy(): AuthPolicy {
		return this.#policy();
	}

	/* Audit rows are evidence, never a reason to fail the operation they
	   describe; a failing write is reported and swallowed. */
	#audit(
		tenantId: string,
		actor: { readonly accountId: string | null; readonly label: string },
		action: string,
		subjectType: string,
		subjectId: string,
		metadata: Readonly<Record<string, unknown>> = {},
	): void {
		try {
			this.#repository.appendAudit({
				tenantId,
				actorAccountId: actor.accountId,
				actorLabel: actor.label,
				action,
				subjectType,
				subjectId,
				metadata,
				occurredAt: this.#now(),
			});
		} catch (error) {
			console.error('[auth.core] audit write failed', error);
		}
	}

	#actorOf(actor: AuthActor): {
		readonly accountId: string;
		readonly label: string;
	} {
		return { accountId: actor.accountId, label: actor.email };
	}

	async #issue(account: AccountCredential): Promise<IssuedSession> {
		const token = randomBytes(32).toString('base64url');
		const csrfToken = randomBytes(24).toString('base64url');
		const createdAt = this.#now();
		const expiresAt = createdAt + this.#policy().sessionTtlMs;
		const sessionId = randomUUID();
		this.#repository.createSession({
			id: sessionId,
			tokenHash: hashSessionToken(token),
			accountId: account.accountId,
			tenantId: account.tenantId,
			csrfToken,
			createdAt,
			expiresAt,
		});
		return {
			token,
			csrfToken,
			expiresAt,
			sessionId,
			passwordChangeRequired: account.passwordChangeRequired,
			principal: {
				accountId: account.accountId,
				tenantId: account.tenantId,
				email: account.email,
				displayName: account.displayName,
				role: account.role,
				scopes: account.scopes,
				tenants: this.#repository.listTenantAccess(account.accountId),
			},
		};
	}

	async signUp(raw: SignUpInput): Promise<IssuedSession> {
		const input = validateSignUp(raw, this.#policy().passwordMinLength);
		const passwordHash = await hashPassword(input.password, this.#passwordHash);
		try {
			const account = this.#repository.createAccountWithTenant({
				accountId: randomUUID(),
				tenantId: randomUUID(),
				email: input.email,
				normalizedEmail: input.email,
				passwordHash,
				displayName: input.displayName,
				organizationName: input.organizationName,
				organizationSlug: input.organizationSlug,
				role: 'owner',
				scopes: OWNER_SCOPES,
				createdAt: this.#now(),
			});
			const issued = await this.#issue(account);
			this.#audit(
				account.tenantId,
				{ accountId: account.accountId, label: account.email },
				AUDIT_ACTIONS.signInSucceeded,
				'session',
				issued.sessionId,
				{ via: 'sign-up' },
			);
			return issued;
		} catch (error) {
			if (error instanceof DuplicateAccountError) {
				// Same code and status as any other rejected sign-up so the
				// response does not confirm that the address is registered.
				throw new AuthServiceError(
					'SIGN_UP_REJECTED',
					'Sign-up could not be completed with these details. If you already have an account, sign in instead.',
					400,
				);
			}
			if (error instanceof DuplicateTenantSlugError) {
				throw new AuthServiceError('WORKSPACE_SLUG_TAKEN', error.message, 409);
			}
			throw error;
		}
	}

	checkWorkspaceSlug(raw: string): {
		readonly slug: string;
		readonly valid: boolean;
		readonly available: boolean;
		readonly message?: string;
	} {
		let slug: string;
		try {
			slug = validateWorkspaceSlug(raw);
		} catch (error) {
			return {
				slug: raw,
				valid: false,
				available: false,
				message:
					error instanceof AuthServiceError
						? error.message
						: 'Workspace id is invalid.',
			};
		}
		return {
			slug,
			valid: true,
			available: !this.#repository.isTenantSlugTaken(slug),
		};
	}

	/* The lockout is keyed by the submitted address whether or not an account
	   exists, so its error never reveals which addresses are registered. */
	async signIn(
		raw: SignInInput,
		context: SignInContext = {},
	): Promise<IssuedSession> {
		const input = validateSignIn(raw);
		const now = this.#now();
		const failure = this.#repository.findSignInFailure(input.email);
		if (failure?.lockedUntil !== null && (failure?.lockedUntil ?? 0) > now) {
			throw new AuthServiceError(
				'ACCOUNT_LOCKED',
				'Too many failed sign-in attempts. Try again later.',
				423,
			);
		}
		const account = this.#repository.findAccountByEmail(input.email);
		if (!account) {
			await hashPassword(input.password, this.#passwordHash);
			this.#recordFailure(input.email, null, context);
			throw this.#invalidCredentials();
		}
		const valid = await verifyPassword(input.password, account.passwordHash);
		if (!valid || account.status !== 'active') {
			this.#recordFailure(input.email, account, context);
			throw this.#invalidCredentials();
		}
		this.#repository.clearSignInFailures(input.email);
		const issued = await this.#issue(account);
		this.#audit(
			account.tenantId,
			{ accountId: account.accountId, label: account.email },
			AUDIT_ACTIONS.signInSucceeded,
			'session',
			issued.sessionId,
			context.address ? { address: context.address } : {},
		);
		return issued;
	}

	#invalidCredentials(): AuthServiceError {
		return new AuthServiceError(
			'INVALID_CREDENTIALS',
			'Email or password is incorrect.',
			401,
		);
	}

	#recordFailure(
		normalizedEmail: string,
		account: AccountCredential | null,
		context: SignInContext,
	): void {
		const record = this.#repository.recordSignInFailure(
			normalizedEmail,
			this.#now(),
			LOCK_THRESHOLD,
			LOCK_MS,
			FAILURE_RETENTION_MS,
		);
		if (!account) return;
		const locked = record.failures >= LOCK_THRESHOLD;
		this.#audit(
			account.tenantId,
			{ accountId: account.accountId, label: account.email },
			locked ? AUDIT_ACTIONS.signInLocked : AUDIT_ACTIONS.signInFailed,
			'account',
			account.accountId,
			{
				failures: record.failures,
				...(context.address ? { address: context.address } : {}),
			},
		);
	}

	listTenantMembers(tenantId: string): readonly TenantMember[] {
		return this.#repository.listTenantMembers(tenantId);
	}

	/* Scopes are authorization metadata, not credentials. Dependent modules read
	   them here instead of interpreting role names or opening the auth database. */
	listMembershipScopes(accountId: string, tenantId: string): readonly string[] {
		return (
			this.#repository.findAccountMembership(accountId, tenantId)?.scopes ?? []
		);
	}

	/* Every scope an administrator may hand out in this workspace: the static
	   owner template plus whatever later modules granted through sync-scopes. */
	listGrantableScopes(tenantId: string): readonly string[] {
		return [
			...new Set([
				...OWNER_SCOPES,
				...this.#repository.listTenantScopes(
					this.#identifier(tenantId, 'tenantId'),
				),
			]),
		].sort();
	}

	/* Self-service credential change. The password never leaves auth.core: a
	   dependent module calls this contract instead of hashing anything itself.
	   Every other session of the account is revoked on success. */
	async changePassword(input: {
		readonly accountId: string;
		readonly currentPassword: string;
		readonly newPassword: string;
		readonly keepSessionToken?: string | null;
	}): Promise<void> {
		const account = this.#repository.findAccountCredentialById(
			this.#identifier(input.accountId, 'accountId'),
		);
		if (!account || account.status !== 'active') {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not available.',
				404,
			);
		}
		const valid = await verifyPassword(
			input.currentPassword,
			account.passwordHash,
		);
		if (!valid) {
			throw new AuthServiceError(
				'INVALID_CREDENTIALS',
				'The current password is incorrect.',
				401,
			);
		}
		assertPasswordPolicy(input.newPassword, this.#policy().passwordMinLength);
		if (input.newPassword === input.currentPassword) {
			throw new AuthServiceError(
				'PASSWORD_UNCHANGED',
				'The new password must differ from the current one.',
				400,
			);
		}
		this.#repository.updatePasswordHash(
			account.accountId,
			await hashPassword(input.newPassword, this.#passwordHash),
			false,
		);
		this.#repository.deleteAccountSessions(
			account.accountId,
			input.keepSessionToken ? hashSessionToken(input.keepSessionToken) : null,
		);
		this.#audit(
			account.tenantId,
			{ accountId: account.accountId, label: account.email },
			AUDIT_ACTIONS.passwordChanged,
			'account',
			account.accountId,
		);
	}

	/* Adds scopes to an existing membership. A composition root uses it to give
	   a workspace the scopes a newly composed module declares; it never widens
	   authority on its own, because the caller decides what to grant. */
	grantMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): readonly string[] {
		const membership = this.#repository.findAccountMembership(
			this.#identifier(accountId, 'accountId'),
			this.#identifier(tenantId, 'tenantId'),
		);
		if (!membership) {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not a member of this workspace.',
				404,
			);
		}
		const held = new Set(membership.scopes);
		const added = [...new Set(scopes)]
			.filter((scope) => SCOPE_PATTERN.test(scope) && !held.has(scope))
			.sort();
		if (added.length > 0) {
			this.#repository.insertMembershipScopes(
				membership.accountId,
				membership.tenantId,
				added,
			);
		}
		return added;
	}

	/* A module that joins the platform brings its own scopes. Nobody holds them
	   yet, so enabling it grants them to the workspace owners; members receive
	   them through role assignment. The grant is idempotent. */
	grantModuleScopes(scopes: readonly string[]): readonly {
		readonly tenantId: string;
		readonly accountId: string;
		readonly granted: readonly string[];
	}[] {
		const results: {
			tenantId: string;
			accountId: string;
			granted: readonly string[];
		}[] = [];
		for (const membership of this.#repository.listOwnerMemberships()) {
			const granted = this.grantMembershipScopes(
				membership.accountId,
				membership.tenantId,
				scopes,
			);
			if (granted.length > 0) {
				results.push({
					tenantId: membership.tenantId,
					accountId: membership.accountId,
					granted,
				});
			}
		}
		return results;
	}

	listTenants(): readonly TenantSummary[] {
		return this.#repository.listTenants();
	}

	/* Tenant lookup by identifier or workspace slug for operator tooling. */
	findTenant(reference: string): TenantSummary | null {
		const normalized = reference.trim().normalize('NFKC');
		if (normalized.length < 1 || normalized.length > 128) return null;
		return (
			this.#repository.findTenant(normalized) ??
			this.#repository.findTenant(normalized.toLowerCase())
		);
	}

	renameTenant(actor: AuthActor, name: string): TenantSummary {
		const renamed = this.#repository.renameTenant(
			actor.tenantId,
			validateWorkspaceName(name),
		);
		if (!renamed) {
			throw new AuthServiceError(
				'TENANT_NOT_FOUND',
				'The workspace does not exist.',
				404,
			);
		}
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.tenantRenamed,
			'tenant',
			actor.tenantId,
			{ name: renamed.name },
		);
		return renamed;
	}

	/* Safe account lookup for operator tooling. It returns identity and
	   membership metadata only, never a password hash or a session token. */
	findAccountAccess(email: string): {
		readonly accountId: string;
		readonly email: string;
		readonly displayName: string;
		readonly tenants: readonly AuthTenantAccess[];
	} | null {
		const account = this.#repository.findAccountByEmail(normalizeEmail(email));
		if (!account) return null;
		return {
			accountId: account.accountId,
			email: account.email,
			displayName: account.displayName,
			tenants: this.#repository.listTenantAccess(account.accountId),
		};
	}

	/* Only an owner may create or promote an owner; every other role is a
	   tenant role row whose scopes become the membership's scopes. */
	#roleForAssignment(actor: AuthActor | null, roleKey: string): TenantRole {
		const tenantId = actor?.tenantId;
		if (roleKey === 'owner' && actor && actor.role !== 'owner') {
			throw new AuthServiceError(
				'OWNER_REQUIRED',
				'Only an owner can grant the owner role.',
				403,
			);
		}
		const role = tenantId
			? this.#repository.findRoleByKey(tenantId, roleKey)
			: null;
		if (!role) {
			throw new AuthServiceError(
				'ROLE_NOT_FOUND',
				'The role does not exist in this workspace.',
				404,
			);
		}
		return role;
	}

	async createTenantMember(
		raw: CreateTenantMemberInput,
		actor: AuthActor | null = null,
	): Promise<TenantMember> {
		const input = validateCreateTenantMember(
			raw,
			this.#policy().passwordMinLength,
		);
		if (actor && actor.tenantId !== input.tenantId) {
			throw new AuthServiceError(
				'TENANT_ACCESS_DENIED',
				'The requested tenant is not available.',
				403,
			);
		}
		const role = actor
			? this.#roleForAssignment(actor, input.role)
			: this.#repository.findRoleByKey(input.tenantId, input.role);
		const scopes = role
			? role.scopes
			: input.role === 'owner'
				? OWNER_SCOPES
				: MEMBER_SCOPES;
		const passwordHash = await hashPassword(input.password, this.#passwordHash);
		try {
			const createdAt = this.#now();
			const account = this.#repository.createAccountInTenant({
				accountId: randomUUID(),
				tenantId: input.tenantId,
				email: input.email,
				normalizedEmail: input.email,
				passwordHash,
				displayName: input.displayName,
				role: input.role,
				roleId: role?.id ?? null,
				scopes,
				createdAt,
			});
			if (actor) {
				this.#audit(
					actor.tenantId,
					this.#actorOf(actor),
					AUDIT_ACTIONS.memberCreated,
					'account',
					account.accountId,
					{ email: account.email, role: input.role },
				);
			}
			return member(account, createdAt);
		} catch (error) {
			if (error instanceof DuplicateAccountError) {
				throw new AuthServiceError('ACCOUNT_EXISTS', error.message, 409);
			}
			throw error;
		}
	}

	#targetMember(
		actor: AuthActor,
		accountId: string,
		options: { readonly allowSelf: boolean },
	): AccountCredential {
		const target = this.#repository.findAccountMembership(
			this.#identifier(accountId, 'accountId'),
			actor.tenantId,
		);
		if (!target) {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not a member of this workspace.',
				404,
			);
		}
		if (!options.allowSelf && target.accountId === actor.accountId) {
			throw new AuthServiceError(
				'SELF_TARGET',
				'Use your profile to change your own account.',
				400,
			);
		}
		if (target.role === 'owner' && actor.role !== 'owner') {
			throw new AuthServiceError(
				'OWNER_REQUIRED',
				'Only an owner can change another owner.',
				403,
			);
		}
		return target;
	}

	#assertOwnerRemains(tenantId: string, target: AccountCredential): void {
		if (
			target.role === 'owner' &&
			target.status === 'active' &&
			this.#repository.countActiveOwners(tenantId) <= 1
		) {
			throw new AuthServiceError(
				'LAST_OWNER',
				'A workspace must keep at least one active owner.',
				409,
			);
		}
	}

	#member(accountId: string, tenantId: string): TenantMember {
		const record = this.#repository
			.listTenantMembers(tenantId)
			.find((entry) => entry.accountId === accountId);
		if (!record) {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not a member of this workspace.',
				404,
			);
		}
		return record;
	}

	updateMemberDisplayName(
		actor: AuthActor,
		accountId: string,
		displayName: string,
	): TenantMember {
		const target = this.#targetMember(actor, accountId, { allowSelf: true });
		const name = validateDisplayName(displayName);
		this.#repository.updateAccountDisplayName(target.accountId, name);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberUpdated,
			'account',
			target.accountId,
			{ displayName: name },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	setMemberStatus(
		actor: AuthActor,
		accountId: string,
		status: 'active' | 'disabled',
	): TenantMember {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		if (status === 'disabled') {
			this.#assertOwnerRemains(actor.tenantId, target);
			this.#repository.deleteAccountSessions(target.accountId, null);
		}
		this.#repository.updateAccountStatus(target.accountId, status);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberStatus,
			'account',
			target.accountId,
			{ status },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	/* Leaves the account intact when it still belongs to another workspace;
	   otherwise the account row goes too, so no orphan credential remains. */
	removeMember(actor: AuthActor, accountId: string): void {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		this.#assertOwnerRemains(actor.tenantId, target);
		this.#repository.deleteMembership(target.accountId, actor.tenantId);
		if (this.#repository.countMemberships(target.accountId) === 0) {
			this.#repository.deleteAccount(target.accountId);
		}
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberRemoved,
			'account',
			target.accountId,
			{ email: target.email },
		);
	}

	/* The administrator sets a temporary password; the member must replace it
	   at the next sign-in. Every session of the account is revoked. */
	async resetMemberPassword(
		actor: AuthActor,
		accountId: string,
		temporaryPassword: string,
	): Promise<TenantMember> {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		assertPasswordPolicy(temporaryPassword, this.#policy().passwordMinLength);
		this.#repository.updatePasswordHash(
			target.accountId,
			await hashPassword(temporaryPassword, this.#passwordHash),
			true,
		);
		this.#repository.deleteAccountSessions(target.accountId, null);
		this.#repository.clearSignInFailures(normalizeEmail(target.email));
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberPasswordReset,
			'account',
			target.accountId,
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	/* A non-owner can only hand out scopes it holds itself; an owner may grant
	   any grantable scope. */
	setMembershipScopes(
		actor: AuthActor,
		accountId: string,
		scopes: readonly string[],
	): TenantMember {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		const grantable = new Set(this.listGrantableScopes(actor.tenantId));
		const held = new Set(actor.scopes);
		const accepted = [...new Set(scopes)].sort();
		for (const scope of accepted) {
			if (!SCOPE_PATTERN.test(scope) || !grantable.has(scope)) {
				throw new AuthServiceError(
					'INVALID_SCOPES',
					`Scope ${scope} cannot be granted in this workspace.`,
					400,
				);
			}
			if (actor.role !== 'owner' && !held.has(scope)) {
				throw new AuthServiceError(
					'SCOPE_CAP_EXCEEDED',
					`You cannot grant ${scope} because you do not hold it.`,
					403,
				);
			}
		}
		this.#repository.replaceMembershipScopes(
			target.accountId,
			actor.tenantId,
			accepted,
		);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberScopes,
			'account',
			target.accountId,
			{ scopes: accepted },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	/* Assigning a role replaces the membership scopes with the role's scopes and
	   keeps the legacy role string in sync for readers of the principal. */
	assignMemberRole(
		actor: AuthActor,
		accountId: string,
		roleKey: string,
	): TenantMember {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		const role = this.#roleForAssignment(actor, validateRoleKey(roleKey));
		if (target.role === 'owner' && role.key !== 'owner') {
			this.#assertOwnerRemains(actor.tenantId, target);
		}
		this.#repository.updateMembershipRole(
			target.accountId,
			actor.tenantId,
			role.key,
			role.id,
			role.scopes,
		);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberRole,
			'account',
			target.accountId,
			{ role: role.key },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	listRoles(tenantId: string): readonly TenantRole[] {
		return this.#repository.listRoles(this.#identifier(tenantId, 'tenantId'));
	}

	#roleScopes(actor: AuthActor, scopes: readonly string[]): readonly string[] {
		const grantable = new Set(this.listGrantableScopes(actor.tenantId));
		const accepted = [...new Set(scopes)].sort();
		if (accepted.length === 0) {
			throw new AuthServiceError(
				'INVALID_SCOPES',
				'A role must grant at least one scope.',
				400,
			);
		}
		for (const scope of accepted) {
			if (!SCOPE_PATTERN.test(scope) || !grantable.has(scope)) {
				throw new AuthServiceError(
					'INVALID_SCOPES',
					`Scope ${scope} cannot be granted in this workspace.`,
					400,
				);
			}
		}
		return accepted;
	}

	createRole(actor: AuthActor, raw: CreateRoleInput): TenantRole {
		if (raw.tenantId !== actor.tenantId) {
			throw new AuthServiceError(
				'TENANT_ACCESS_DENIED',
				'The requested tenant is not available.',
				403,
			);
		}
		const key = validateRoleKey(raw.key);
		if (key === 'owner' || key === 'member') {
			throw new AuthServiceError(
				'ROLE_RESERVED',
				'The owner and member roles are built in.',
				409,
			);
		}
		try {
			const role = this.#repository.createRole({
				id: randomUUID(),
				tenantId: actor.tenantId,
				key,
				name: validateRoleName(raw.name),
				description: validateRoleDescription(raw.description),
				scopes: this.#roleScopes(actor, raw.scopes),
				builtin: false,
				createdAt: this.#now(),
			});
			this.#audit(
				actor.tenantId,
				this.#actorOf(actor),
				AUDIT_ACTIONS.roleCreated,
				'role',
				role.id,
				{ key: role.key, scopes: role.scopes },
			);
			return role;
		} catch (error) {
			if (error instanceof DuplicateRoleKeyError) {
				throw new AuthServiceError('ROLE_EXISTS', error.message, 409);
			}
			throw error;
		}
	}

	#editableRole(tenantId: string, id: string): TenantRole {
		const role = this.#repository.findRole(
			tenantId,
			this.#identifier(id, 'id'),
		);
		if (!role) {
			throw new AuthServiceError(
				'ROLE_NOT_FOUND',
				'The role does not exist in this workspace.',
				404,
			);
		}
		if (role.builtin) {
			throw new AuthServiceError(
				'ROLE_BUILTIN',
				'Built-in roles cannot be changed.',
				409,
			);
		}
		return role;
	}

	updateRole(actor: AuthActor, raw: UpdateRoleInput): TenantRole {
		if (raw.tenantId !== actor.tenantId) {
			throw new AuthServiceError(
				'TENANT_ACCESS_DENIED',
				'The requested tenant is not available.',
				403,
			);
		}
		const current = this.#editableRole(actor.tenantId, raw.id);
		const scopes =
			raw.scopes === undefined
				? current.scopes
				: this.#roleScopes(actor, raw.scopes);
		const updated = this.#repository.updateRole(
			actor.tenantId,
			current.id,
			{
				name:
					raw.name === undefined ? current.name : validateRoleName(raw.name),
				description:
					raw.description === undefined
						? current.description
						: validateRoleDescription(raw.description),
				scopes,
			},
			this.#now(),
		)!;
		if (raw.scopes !== undefined) {
			for (const membership of this.#repository
				.listTenantMembers(actor.tenantId)
				.filter((entry) => entry.roleId === current.id)) {
				this.#repository.replaceMembershipScopes(
					membership.accountId,
					actor.tenantId,
					scopes,
				);
			}
		}
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.roleUpdated,
			'role',
			updated.id,
			{ key: updated.key, scopes: updated.scopes },
		);
		return updated;
	}

	deleteRole(actor: AuthActor, id: string): void {
		const role = this.#editableRole(actor.tenantId, id);
		if (this.#repository.countRoleMemberships(actor.tenantId, role.id) > 0) {
			throw new AuthServiceError(
				'ROLE_IN_USE',
				'Reassign every member before deleting this role.',
				409,
			);
		}
		this.#repository.deleteRole(actor.tenantId, role.id);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.roleDeleted,
			'role',
			role.id,
			{ key: role.key },
		);
	}

	resolveSession(token: string | null): AuthSession | null {
		if (!token) return null;
		return this.#repository.findSession(
			hashSessionToken(token),
			this.#now(),
			this.#policy().sessionIdleMs,
			SESSION_TOUCH_INTERVAL_MS,
		);
	}

	listSessions(accountId: string): readonly SessionSummary[] {
		return this.#repository.listAccountSessions(
			this.#identifier(accountId, 'accountId'),
			this.#now(),
		);
	}

	revokeOwnSession(session: AuthSession, sessionId: string): void {
		const removed = this.#repository.deleteSessionById(
			session.principal.accountId,
			this.#identifier(sessionId, 'sessionId'),
		);
		if (!removed) {
			throw new AuthServiceError(
				'SESSION_NOT_FOUND',
				'The session does not exist.',
				404,
			);
		}
		this.#audit(
			session.principal.tenantId,
			{
				accountId: session.principal.accountId,
				label: session.principal.email,
			},
			AUDIT_ACTIONS.sessionRevoked,
			'session',
			sessionId,
		);
	}

	revokeMemberSessions(actor: AuthActor, accountId: string): number {
		const target = this.#targetMember(actor, accountId, { allowSelf: false });
		const before = this.#repository.listAccountSessions(
			target.accountId,
			this.#now(),
		).length;
		this.#repository.deleteAccountSessions(target.accountId, null);
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.sessionRevoked,
			'account',
			target.accountId,
			{ sessions: before },
		);
		return before;
	}

	deleteExpiredSessions(): number {
		return this.#repository.deleteExpiredSessions(this.#now());
	}

	recordSettingsUpdate(
		actor: AuthActor,
		moduleId: string,
		key: string,
		cleared: boolean,
	): void {
		this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.settingsUpdated,
			'setting',
			`${moduleId}.${key}`,
			{ cleared },
		);
	}

	queryAudit(query: AuditQuery): AuditPage {
		const limit = Math.min(
			Math.max(1, Math.trunc(query.limit)),
			MAX_AUDIT_PAGE,
		);
		const events = this.#repository.queryAudit({
			...query,
			tenantId: this.#identifier(query.tenantId, 'tenantId'),
			limit: limit + 1,
		});
		const page = events.slice(0, limit);
		const last = page[page.length - 1];
		return {
			events: page,
			nextCursor:
				events.length > limit && last ? `${last.occurredAt}:${last.id}` : null,
		};
	}

	async switchTenant(token: string, tenantId: string): Promise<IssuedSession> {
		const current = this.resolveSession(token);
		if (!current) {
			throw new AuthServiceError(
				'UNAUTHENTICATED',
				'Authentication is required.',
				401,
			);
		}
		if (!current.principal.scopes.includes(AUTH_SCOPES.tenantSwitch)) {
			throw new AuthServiceError(
				'FORBIDDEN',
				'Tenant switching was not granted.',
				403,
			);
		}
		const account = this.#repository.findAccountMembership(
			current.principal.accountId,
			tenantId,
		);
		if (!account) {
			throw new AuthServiceError(
				'TENANT_ACCESS_DENIED',
				'The requested tenant is not available.',
				403,
			);
		}
		this.#repository.deleteSession(hashSessionToken(token));
		return this.#issue(account);
	}

	/* API tokens are machine credentials for clients that cannot hold a browser
	   session, such as a sandbox connected to a remote deployment. Only the hash
	   is stored, the raw value is returned exactly once, and effective authority
	   is always re-intersected with the live membership scopes. */
	issueApiToken(raw: CreateApiTokenInput): IssuedApiToken {
		const tenantId = this.#identifier(raw.tenantId, 'tenantId');
		const accountId = this.#identifier(raw.accountId, 'accountId');
		const createdBy = this.#identifier(raw.createdBy, 'createdBy');
		const label = raw.label.trim();
		if (label.length < 2 || label.length > 80) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				'Token label must contain between 2 and 80 characters.',
				400,
			);
		}
		const membership = this.#repository.findAccountMembership(
			accountId,
			tenantId,
		);
		if (!membership || membership.status !== 'active') {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not an active member of this workspace.',
				404,
			);
		}
		if (raw.scopes.length === 0 || raw.scopes.length > 64) {
			throw new AuthServiceError(
				'INVALID_SCOPES',
				'A token must carry between 1 and 64 scopes.',
				400,
			);
		}
		for (const scope of raw.scopes) {
			if (!SCOPE_PATTERN.test(scope)) {
				throw new AuthServiceError(
					'INVALID_SCOPES',
					`Scope ${scope} is not a valid identifier.`,
					400,
				);
			}
		}
		const held = new Set(membership.scopes);
		const scopes = [...new Set(raw.scopes)]
			.filter((scope) => held.has(scope))
			.sort();
		if (scopes.length === 0) {
			throw new AuthServiceError(
				'INVALID_SCOPES',
				'None of the requested scopes are held by this membership.',
				409,
			);
		}
		const createdAt = this.#now();
		if (raw.expiresAt !== null) {
			if (
				!Number.isSafeInteger(raw.expiresAt) ||
				raw.expiresAt <= createdAt ||
				raw.expiresAt - createdAt > MAX_API_TOKEN_LIFETIME_MS
			) {
				throw new AuthServiceError(
					'INVALID_EXPIRY',
					'Token expiry must be a future timestamp within one year.',
					400,
				);
			}
		}
		const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
		const record = this.#repository.createApiToken({
			id: randomUUID(),
			tenantId,
			accountId,
			label,
			prefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
			tokenHash: hashSessionToken(token),
			scopes,
			createdBy,
			createdAt,
			expiresAt: raw.expiresAt,
		});
		this.#audit(
			tenantId,
			{ accountId: createdBy, label: membership.email },
			AUDIT_ACTIONS.tokenIssued,
			'api-token',
			record.id,
			{ label, scopes },
		);
		return { record, token };
	}

	listApiTokens(tenantId: string): readonly ApiTokenRecord[] {
		return this.#repository.listApiTokens(
			this.#identifier(tenantId, 'tenantId'),
		);
	}

	revokeApiToken(
		tenantId: string,
		id: string,
		revokedBy: string,
	): ApiTokenRecord {
		const record = this.#repository.revokeApiToken(
			this.#identifier(tenantId, 'tenantId'),
			this.#identifier(id, 'id'),
			this.#now(),
			this.#identifier(revokedBy, 'revokedBy'),
		);
		if (!record) {
			throw new AuthServiceError(
				'TOKEN_NOT_FOUND',
				'The API token does not exist in this workspace.',
				404,
			);
		}
		this.#audit(
			record.tenantId,
			{ accountId: revokedBy, label: revokedBy },
			AUDIT_ACTIONS.tokenRevoked,
			'api-token',
			record.id,
			{ label: record.label },
		);
		return record;
	}

	resolveApiToken(raw: string | null): AuthPrincipal | null {
		if (!raw || !API_TOKEN_PATTERN.test(raw)) return null;
		const record = this.#repository.findApiTokenByHash(hashSessionToken(raw));
		if (!record || record.revokedAt !== null) return null;
		const now = this.#now();
		if (record.expiresAt !== null && record.expiresAt <= now) return null;
		const membership = this.#repository.findAccountMembership(
			record.accountId,
			record.tenantId,
		);
		if (!membership || membership.status !== 'active') return null;
		const held = new Set(membership.scopes);
		const scopes = record.scopes.filter((scope) => held.has(scope));
		if (scopes.length === 0) return null;
		if (
			record.lastUsedAt === null ||
			now - record.lastUsedAt > API_TOKEN_TOUCH_INTERVAL_MS
		) {
			this.#repository.touchApiToken(record.id, now);
		}
		return {
			accountId: membership.accountId,
			tenantId: membership.tenantId,
			email: membership.email,
			displayName: membership.displayName,
			role: membership.role,
			scopes,
			tenants: this.#repository.listTenantAccess(membership.accountId),
		};
	}

	#identifier(value: string, field: string): string {
		const normalized = value.trim();
		if (normalized.length < 1 || normalized.length > 128) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`${field} must contain between 1 and 128 characters.`,
				400,
			);
		}
		return normalized;
	}

	signOut(token: string): void {
		const session = this.resolveSession(token);
		this.#repository.deleteSession(hashSessionToken(token));
		if (session) {
			this.#audit(
				session.principal.tenantId,
				{
					accountId: session.principal.accountId,
					label: session.principal.email,
				},
				AUDIT_ACTIONS.signOut,
				'session',
				session.sessionId,
			);
		}
	}
}
