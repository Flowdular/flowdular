import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { userActor, type Actor } from '@flowdular/kernel';
import { AUTH_SCOPES, MEMBER_SCOPES, OWNER_SCOPES } from '../acl/scopes.ts';
import type {
	ApiTokenRecord,
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
	type AuditActorEvent,
	type AuthRepository,
	type TenantMember,
	type TenantSummary,
} from './repository.ts';
import type { AuthMailDelivery } from './mail-delivery.ts';
import {
	createTotpSecret,
	decryptMfaSecret,
	encryptMfaSecret,
	verifyTotp,
} from './totp.ts';
import {
	assertPasswordPolicy,
	normalizeEmail,
	validateCreateTenantMember,
	validateDisplayName,
	validateEmailAddress,
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

/* The audit page plus the actor columns added by 0014; assignable wherever an
   AuditPage was expected. */
export interface AuditActorPage {
	readonly events: readonly AuditActorEvent[];
	readonly nextCursor: string | null;
}

export interface AuthServiceOptions {
	readonly sessionTtlMs?: number;
	/** Live policy; read on every call so settings changes apply immediately. */
	readonly policy?: () => AuthPolicy;
	readonly passwordHash?: PasswordHashOptions;
	readonly now?: () => number;
	/** AES-256-GCM key used only to protect enrolled TOTP secrets at rest. */
	readonly mfaEncryptionKey?: string;
	/** Deployment-owned delivery adapter. auth.core never selects an email vendor. */
	readonly mailDelivery?: AuthMailDelivery;
	/** Public origin used to form opaque, one-time delivery links. */
	readonly publicBaseUrl?: string;
}

export interface MfaChallenge extends IssuedSession {
	readonly mfaRequired: true;
	/* This is a short-lived proof of a successful password check, never a session. */
	readonly token: string;
	readonly expiresAt: number;
}

export interface MfaStatus {
	readonly available: boolean;
	readonly enrolled: boolean;
	readonly pending: boolean;
}

/** How the first credential of a provisioned account reaches the operator. */
export type OperatorCredentialKind =
	| 'password-setup-link'
	| 'operator-password'
	| 'invitation-link'
	| 'existing-password';

export interface OperatorCredential {
	readonly kind: OperatorCredentialKind;
	/* Carried by the link kinds only. Returned once, because only its hash is
	   stored and nothing can recover it afterwards. */
	readonly url?: string;
	readonly expiresAt?: number;
}

export interface WorkspaceProvisionInput {
	readonly name: string;
	readonly slug: string;
	readonly ownerEmail: string;
	readonly ownerDisplayName: string;
	/* Chosen by the operator and supplied out of band. Leaving it out issues a
	   single-use setup link instead, so no password the operator did not choose
	   is ever returned. */
	readonly password?: string;
	/** Audit label of the operator, such as `cli:ada`. */
	readonly operator: string;
}

export interface WorkspaceProvisionPlan {
	readonly workspace: { readonly name: string; readonly slug: string };
	readonly owner: {
		readonly email: string;
		readonly displayName: string;
		readonly role: string;
		readonly scopes: readonly string[];
	};
	/* The same field the applied result carries, so a plan and an apply parse
	   the same way. Only the applied one adds the link itself. */
	readonly credential: { readonly kind: OperatorCredentialKind };
	readonly operator: string;
}

export interface ProvisionedWorkspace {
	readonly workspace: TenantSummary;
	readonly owner: {
		readonly accountId: string;
		readonly email: string;
		readonly displayName: string;
		readonly role: string;
		readonly scopes: readonly string[];
	};
	readonly credential: OperatorCredential;
	readonly operator: string;
}

export interface MemberProvisionInput {
	/** Workspace slug or identifier. */
	readonly workspace: string;
	readonly email: string;
	readonly role: string;
	readonly operator: string;
}

export interface MemberProvisionPlan {
	readonly workspace: TenantSummary;
	readonly email: string;
	readonly role: TenantRole;
	/* An address that already has an account joins immediately; an unknown one
	   receives an invitation and creates its own account. */
	readonly action: 'membership' | 'invitation';
	readonly account: {
		readonly accountId: string;
		readonly email: string;
		readonly displayName: string;
	} | null;
	readonly credential: { readonly kind: OperatorCredentialKind };
	readonly operator: string;
}

export interface ProvisionedMember {
	readonly workspace: TenantSummary;
	readonly email: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly action: 'membership' | 'invitation';
	readonly accountId: string | null;
	readonly invitationId: string | null;
	readonly credential: OperatorCredential;
	readonly operator: string;
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
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* An operator carries this link to a person by hand, which the 30 minutes of a
   self-service reset does not survive. It stays single use and hashed at rest. */
const OPERATOR_SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

export const AUDIT_ACTIONS = Object.freeze({
	signInSucceeded: 'auth.sign-in.succeeded',
	signInFailed: 'auth.sign-in.failed',
	signInLocked: 'auth.sign-in.locked',
	signOut: 'auth.sign-out',
	sessionRevoked: 'auth.session.revoked',
	passwordChanged: 'auth.password.changed',
	tokenIssued: 'auth.token.issued',
	tokenRevoked: 'auth.token.revoked',
	passwordResetRequested: 'auth.password-reset.requested',
	passwordResetCompleted: 'auth.password-reset.completed',
	invitationCreated: 'auth.invitation.created',
	invitationAccepted: 'auth.invitation.accepted',
	mfaEnrolled: 'auth.mfa.enrolled',
	mfaConfirmed: 'auth.mfa.confirmed',
	mfaChallengeSucceeded: 'auth.mfa.challenge-succeeded',
	tenantRenamed: 'auth.tenant.renamed',
	workspaceProvisioned: 'auth.workspace.provisioned',
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

/* An operator command runs from a deployment shell and belongs to no account.
   The audit actor_kind column accepts only 'user' or 'agent', so the operator
   is recorded as a user whose identifier carries the cli: prefix the label
   filter can search for. */
function operatorActor(operator: string): Actor {
	return { kind: 'user', id: operator, label: operator };
}

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
	readonly #mfaEncryptionKey: string | undefined;
	readonly #mailDelivery: AuthMailDelivery | undefined;
	readonly #publicBaseUrl: string;

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
		this.#mfaEncryptionKey = options.mfaEncryptionKey;
		this.#mailDelivery = options.mailDelivery;
		this.#publicBaseUrl = (options.publicBaseUrl ?? 'http://localhost').replace(
			/\/$/,
			'',
		);
	}

	get policy(): AuthPolicy {
		return this.#policy();
	}

	/* Audit rows are evidence, never a reason to fail the operation they
	   describe; a failing write is reported and swallowed. */
	async #audit(
		tenantId: string,
		actor: Actor,
		action: string,
		subjectType: string,
		subjectId: string,
		metadata: Readonly<Record<string, unknown>> = {},
	): Promise<void> {
		try {
			await this.#repository.appendAudit({
				tenantId,
				actorAccountId: actor.kind === 'user' ? actor.id : null,
				actorLabel: actor.label,
				actorKind: actor.kind,
				actorRunId: actor.kind === 'agent' ? actor.runId : null,
				action,
				subjectType,
				subjectId,
				metadata,
				occurredAt: this.#now(),
			});
		} catch (error) {
			/* Audit failures must not leak a driver error, whose detail can include
			   bound values from the operation being audited. */
			void error;
			console.error('[auth.core] audit write failed');
		}
	}

	#actorOf(actor: AuthActor): Actor {
		return userActor(actor);
	}

	async #issue(account: AccountCredential): Promise<IssuedSession> {
		const token = randomBytes(32).toString('base64url');
		const csrfToken = randomBytes(24).toString('base64url');
		const createdAt = this.#now();
		const expiresAt = createdAt + this.#policy().sessionTtlMs;
		const sessionId = randomUUID();
		await this.#repository.createSession({
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
				tenants: await this.#repository.listTenantAccess(account.accountId),
			},
		};
	}

	async signUp(raw: SignUpInput): Promise<IssuedSession> {
		const input = validateSignUp(raw, this.#policy().passwordMinLength);
		const passwordHash = await hashPassword(input.password, this.#passwordHash);
		try {
			const account = await this.#repository.createAccountWithTenant({
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
			await this.#audit(
				account.tenantId,
				{ kind: 'user', id: account.accountId, label: account.email },
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

	async checkWorkspaceSlug(raw: string): Promise<{
		readonly slug: string;
		readonly valid: boolean;
		readonly available: boolean;
		readonly message?: string;
	}> {
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
			available: !(await this.#repository.isTenantSlugTaken(slug)),
		};
	}

	/* The lockout is keyed by the submitted address whether or not an account
	   exists, so its error never reveals which addresses are registered. */
	async signIn(
		raw: SignInInput,
		context: SignInContext = {},
	): Promise<IssuedSession & { readonly mfaRequired?: true }> {
		const input = validateSignIn(raw);
		const now = this.#now();
		const failure = await this.#repository.findSignInFailure(input.email);
		if (failure?.lockedUntil !== null && (failure?.lockedUntil ?? 0) > now) {
			throw new AuthServiceError(
				'ACCOUNT_LOCKED',
				'Too many failed sign-in attempts. Try again later.',
				423,
			);
		}
		const account = await this.#repository.findAccountByEmail(input.email);
		if (!account) {
			await hashPassword(input.password, this.#passwordHash);
			await this.#recordFailure(input.email, null, context);
			throw this.#invalidCredentials();
		}
		const valid = await verifyPassword(input.password, account.passwordHash);
		if (!valid || account.status !== 'active') {
			await this.#recordFailure(input.email, account, context);
			throw this.#invalidCredentials();
		}
		await this.#repository.clearSignInFailures(input.email);
		const mfa = await this.#repository.findMfaTotp(account.accountId);
		if (mfa?.confirmedAt !== null && mfa?.confirmedAt !== undefined)
			return this.#issueMfaChallenge(account, now);
		const issued = await this.#issue(account);
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.signInSucceeded,
			'session',
			issued.sessionId,
			context.address ? { address: context.address } : {},
		);
		return issued;
	}

	async #issueMfaChallenge(
		account: AccountCredential,
		now = this.#now(),
	): Promise<MfaChallenge> {
		const token = randomBytes(32).toString('base64url');
		await this.#repository.createMfaChallenge({
			tokenHash: hashSessionToken(token),
			accountId: account.accountId,
			tenantId: account.tenantId,
			expiresAt: now + MFA_CHALLENGE_TTL_MS,
			createdAt: now,
		});
		/* `token` is a short-lived proof of the first factor, never a session. */
		return {
			mfaRequired: true,
			token,
			csrfToken: '',
			sessionId: '',
			expiresAt: now + MFA_CHALLENGE_TTL_MS,
			passwordChangeRequired: account.passwordChangeRequired,
			principal: {
				accountId: account.accountId,
				tenantId: account.tenantId,
				email: account.email,
				displayName: account.displayName,
				role: account.role,
				scopes: [],
				tenants: [],
			},
		};
	}

	#invalidCredentials(): AuthServiceError {
		return new AuthServiceError(
			'INVALID_CREDENTIALS',
			'Email or password is incorrect.',
			401,
		);
	}

	async #recordFailure(
		normalizedEmail: string,
		account: AccountCredential | null,
		context: SignInContext,
	): Promise<void> {
		const record = await this.#repository.recordSignInFailure(
			normalizedEmail,
			this.#now(),
			LOCK_THRESHOLD,
			LOCK_MS,
			FAILURE_RETENTION_MS,
		);
		if (!account) return;
		const locked = record.failures >= LOCK_THRESHOLD;
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			locked ? AUDIT_ACTIONS.signInLocked : AUDIT_ACTIONS.signInFailed,
			'account',
			account.accountId,
			{
				failures: record.failures,
				...(context.address ? { address: context.address } : {}),
			},
		);
	}

	async listTenantMembers(tenantId: string): Promise<readonly TenantMember[]> {
		return this.#repository.listTenantMembers(tenantId);
	}

	/* Scopes are authorization metadata, not credentials. Dependent modules read
	   them here instead of interpreting role names or opening the auth database. */
	async listMembershipScopes(
		accountId: string,
		tenantId: string,
	): Promise<readonly string[]> {
		return (
			(await this.#repository.findAccountMembership(accountId, tenantId))
				?.scopes ?? []
		);
	}

	/* Every scope an administrator may hand out in this workspace: the static
	   owner template plus whatever later modules granted through sync-scopes. */
	async listGrantableScopes(tenantId: string): Promise<readonly string[]> {
		return [
			...new Set([
				...OWNER_SCOPES,
				...(await this.#repository.listTenantScopes(
					this.#identifier(tenantId, 'tenantId'),
				)),
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
		const account = await this.#repository.findAccountCredentialById(
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
		await this.#repository.updatePasswordHash(
			account.accountId,
			await hashPassword(input.newPassword, this.#passwordHash),
			false,
		);
		await this.#repository.deleteAccountSessions(
			account.accountId,
			input.keepSessionToken ? hashSessionToken(input.keepSessionToken) : null,
		);
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.passwordChanged,
			'account',
			account.accountId,
		);
	}

	/* Adds scopes to an existing membership. A composition root uses it to give
	   a workspace the scopes a newly composed module declares; it never widens
	   authority on its own, because the caller decides what to grant. */
	async grantMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<readonly string[]> {
		const membership = await this.#repository.findAccountMembership(
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
			await this.#repository.insertMembershipScopes(
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
	async grantModuleScopes(scopes: readonly string[]): Promise<
		readonly {
			readonly tenantId: string;
			readonly accountId: string;
			readonly granted: readonly string[];
		}[]
	> {
		const results: {
			tenantId: string;
			accountId: string;
			granted: readonly string[];
		}[] = [];
		const accepted = [...new Set(scopes)]
			.filter((scope) => SCOPE_PATTERN.test(scope))
			.sort();
		if (accepted.length === 0) return results;
		/* The role and its memberships commit together within each tenant. Future
		   owners inherit the role; arbitrary membership grants never become defaults. */
		for (const tenant of await this.#repository.listTenants()) {
			for (const granted of await this.#repository.grantTenantOwnerScopes(
				tenant.tenantId,
				accepted,
				this.#now(),
			)) {
				results.push({ tenantId: tenant.tenantId, ...granted });
			}
		}
		return results;
	}

	async listTenants(): Promise<readonly TenantSummary[]> {
		return this.#repository.listTenants();
	}

	/* Tenant lookup by identifier or workspace slug for operator tooling. */
	async findTenant(reference: string): Promise<TenantSummary | null> {
		const normalized = reference.trim().normalize('NFKC');
		if (normalized.length < 1 || normalized.length > 128) return null;
		return (
			(await this.#repository.findTenant(normalized)) ??
			(await this.#repository.findTenant(normalized.toLowerCase()))
		);
	}

	async renameTenant(actor: AuthActor, name: string): Promise<TenantSummary> {
		const renamed = await this.#repository.renameTenant(
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
		await this.#audit(
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
	async findAccountAccess(email: string): Promise<{
		readonly accountId: string;
		readonly email: string;
		readonly displayName: string;
		readonly tenants: readonly AuthTenantAccess[];
	} | null> {
		const account = await this.#repository.findAccountByEmail(
			normalizeEmail(email),
		);
		if (!account) return null;
		return {
			accountId: account.accountId,
			email: account.email,
			displayName: account.displayName,
			tenants: await this.#repository.listTenantAccess(account.accountId),
		};
	}

	/* Only an owner may create or promote an owner; every other role is a
	   tenant role row whose scopes become the membership's scopes. */
	async #roleForAssignment(
		actor: AuthActor | null,
		roleKey: string,
	): Promise<TenantRole> {
		const tenantId = actor?.tenantId;
		if (roleKey === 'owner' && actor && actor.role !== 'owner') {
			throw new AuthServiceError(
				'OWNER_REQUIRED',
				'Only an owner can grant the owner role.',
				403,
			);
		}
		const role = tenantId
			? await this.#repository.findRoleByKey(tenantId, roleKey)
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
			? await this.#roleForAssignment(actor, input.role)
			: await this.#repository.findRoleByKey(input.tenantId, input.role);
		const scopes = role
			? role.scopes
			: input.role === 'owner'
				? OWNER_SCOPES
				: MEMBER_SCOPES;
		const passwordHash = await hashPassword(input.password, this.#passwordHash);
		try {
			const createdAt = this.#now();
			const account = await this.#repository.createAccountInTenant({
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
				await this.#audit(
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

	async #targetMember(
		actor: AuthActor,
		accountId: string,
		options: { readonly allowSelf: boolean },
	): Promise<AccountCredential> {
		const target = await this.#repository.findAccountMembership(
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

	async #assertOwnerRemains(
		tenantId: string,
		target: AccountCredential,
	): Promise<void> {
		if (
			target.role === 'owner' &&
			target.status === 'active' &&
			(await this.#repository.countActiveOwners(tenantId)) <= 1
		) {
			throw new AuthServiceError(
				'LAST_OWNER',
				'A workspace must keep at least one active owner.',
				409,
			);
		}
	}

	async #member(accountId: string, tenantId: string): Promise<TenantMember> {
		const record = (await this.#repository.listTenantMembers(tenantId)).find(
			(entry) => entry.accountId === accountId,
		);
		if (!record) {
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not a member of this workspace.',
				404,
			);
		}
		return record;
	}

	async updateMemberDisplayName(
		actor: AuthActor,
		accountId: string,
		displayName: string,
	): Promise<TenantMember> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: true,
		});
		const name = validateDisplayName(displayName);
		await this.#repository.updateAccountDisplayName(target.accountId, name);
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberUpdated,
			'account',
			target.accountId,
			{ displayName: name },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	async setMemberStatus(
		actor: AuthActor,
		accountId: string,
		status: 'active' | 'disabled',
	): Promise<TenantMember> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		if (status === 'disabled') {
			await this.#assertOwnerRemains(actor.tenantId, target);
			await this.#repository.deleteAccountSessions(target.accountId, null);
		}
		await this.#repository.updateAccountStatus(target.accountId, status);
		await this.#audit(
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
	async removeMember(actor: AuthActor, accountId: string): Promise<void> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		await this.#assertOwnerRemains(actor.tenantId, target);
		await this.#repository.deleteMembership(target.accountId, actor.tenantId);
		if ((await this.#repository.countMemberships(target.accountId)) === 0) {
			await this.#repository.deleteAccount(target.accountId);
		}
		await this.#audit(
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
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		assertPasswordPolicy(temporaryPassword, this.#policy().passwordMinLength);
		await this.#repository.updatePasswordHash(
			target.accountId,
			await hashPassword(temporaryPassword, this.#passwordHash),
			true,
		);
		await this.#repository.deleteAccountSessions(target.accountId, null);
		await this.#repository.clearSignInFailures(normalizeEmail(target.email));
		await this.#audit(
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
	async setMembershipScopes(
		actor: AuthActor,
		accountId: string,
		scopes: readonly string[],
	): Promise<TenantMember> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		const grantable = new Set(await this.listGrantableScopes(actor.tenantId));
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
		await this.#repository.replaceMembershipScopes(
			target.accountId,
			actor.tenantId,
			accepted,
		);
		await this.#audit(
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
	async assignMemberRole(
		actor: AuthActor,
		accountId: string,
		roleKey: string,
	): Promise<TenantMember> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		const role = await this.#roleForAssignment(actor, validateRoleKey(roleKey));
		if (target.role === 'owner' && role.key !== 'owner') {
			await this.#assertOwnerRemains(actor.tenantId, target);
		}
		await this.#repository.updateMembershipRole(
			target.accountId,
			actor.tenantId,
			role.key,
			role.id,
			role.scopes,
		);
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.memberRole,
			'account',
			target.accountId,
			{ role: role.key },
		);
		return this.#member(target.accountId, actor.tenantId);
	}

	async listRoles(tenantId: string): Promise<readonly TenantRole[]> {
		return this.#repository.listRoles(this.#identifier(tenantId, 'tenantId'));
	}

	async #roleScopes(
		actor: AuthActor,
		scopes: readonly string[],
	): Promise<readonly string[]> {
		const grantable = new Set(await this.listGrantableScopes(actor.tenantId));
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

	async createRole(
		actor: AuthActor,
		raw: CreateRoleInput,
	): Promise<TenantRole> {
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
			const role = await this.#repository.createRole({
				id: randomUUID(),
				tenantId: actor.tenantId,
				key,
				name: validateRoleName(raw.name),
				description: validateRoleDescription(raw.description),
				scopes: await this.#roleScopes(actor, raw.scopes),
				builtin: false,
				createdAt: this.#now(),
			});
			await this.#audit(
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

	async #editableRole(tenantId: string, id: string): Promise<TenantRole> {
		const role = await this.#repository.findRole(
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

	async updateRole(
		actor: AuthActor,
		raw: UpdateRoleInput,
	): Promise<TenantRole> {
		if (raw.tenantId !== actor.tenantId) {
			throw new AuthServiceError(
				'TENANT_ACCESS_DENIED',
				'The requested tenant is not available.',
				403,
			);
		}
		const current = await this.#editableRole(actor.tenantId, raw.id);
		const scopes =
			raw.scopes === undefined
				? current.scopes
				: await this.#roleScopes(actor, raw.scopes);
		const updated = (await this.#repository.updateRole(
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
		))!;
		if (raw.scopes !== undefined) {
			for (const membership of (
				await this.#repository.listTenantMembers(actor.tenantId)
			).filter((entry) => entry.roleId === current.id)) {
				await this.#repository.replaceMembershipScopes(
					membership.accountId,
					actor.tenantId,
					scopes,
				);
			}
		}
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.roleUpdated,
			'role',
			updated.id,
			{ key: updated.key, scopes: updated.scopes },
		);
		return updated;
	}

	async deleteRole(actor: AuthActor, id: string): Promise<void> {
		const role = await this.#editableRole(actor.tenantId, id);
		if (
			(await this.#repository.countRoleMemberships(actor.tenantId, role.id)) > 0
		) {
			throw new AuthServiceError(
				'ROLE_IN_USE',
				'Reassign every member before deleting this role.',
				409,
			);
		}
		await this.#repository.deleteRole(actor.tenantId, role.id);
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.roleDeleted,
			'role',
			role.id,
			{ key: role.key },
		);
	}

	/* One password reset token, minted the same way for every caller: random,
	   stored only as a hash, single use, and handed back with its link because
	   the caller decides how it reaches the person. Mail is one such caller and
	   an operator terminal is another; a deployment with no mail adapter still
	   has to be able to hand an owner its first credential. */
	async #mintPasswordResetToken(
		accountId: string,
		ttlMs: number,
	): Promise<{ readonly url: string; readonly expiresAt: number }> {
		const now = this.#now();
		const token = randomBytes(32).toString('base64url');
		const expiresAt = now + ttlMs;
		await this.#repository.createPasswordResetToken({
			tokenHash: hashSessionToken(token),
			accountId,
			expiresAt,
			createdAt: now,
		});
		return {
			url: `${this.#publicBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`,
			expiresAt,
		};
	}

	/* The same contract for an invitation token. */
	async #mintTenantInvitation(record: {
		readonly tenantId: string;
		readonly normalizedEmail: string;
		readonly roleKey: string;
		readonly createdBy: string;
	}): Promise<{
		readonly id: string;
		readonly url: string;
		readonly expiresAt: number;
	}> {
		const now = this.#now();
		const token = randomBytes(32).toString('base64url');
		const id = randomUUID();
		const expiresAt = now + INVITATION_TTL_MS;
		await this.#repository.createTenantInvitation({
			id,
			tenantId: record.tenantId,
			email: record.normalizedEmail,
			normalizedEmail: record.normalizedEmail,
			roleKey: record.roleKey,
			tokenHash: hashSessionToken(token),
			expiresAt,
			createdBy: record.createdBy,
			createdAt: now,
		});
		return {
			id,
			url: `${this.#publicBaseUrl}/auth/accept-invitation?token=${encodeURIComponent(token)}`,
			expiresAt,
		};
	}

	/* Public reset requests intentionally have no observable distinction between
	   a known and unknown address. A delivery failure is also treated as accepted
	   so it cannot become an address-enumeration side channel. */
	async requestPasswordReset(email: string): Promise<void> {
		const normalized = normalizeEmail(email);
		if (normalized.length > 254) return;
		const account = await this.#repository.findAccountByEmail(normalized);
		if (!account || !this.#mailDelivery) return;
		const reset = await this.#mintPasswordResetToken(
			account.accountId,
			PASSWORD_RESET_TTL_MS,
		);
		try {
			await this.#mailDelivery.send({
				to: account.email,
				kind: 'password-reset',
				url: reset.url,
			});
			await this.#audit(
				account.tenantId,
				{ kind: 'user', id: account.accountId, label: account.email },
				AUDIT_ACTIONS.passwordResetRequested,
				'account',
				account.accountId,
			);
		} catch {
			/* The response stays non-enumerating. A deployment-owned adapter owns
			   its delivery retry and observability policy. */
		}
	}

	async completePasswordReset(token: string, password: string): Promise<void> {
		if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
			throw new AuthServiceError(
				'RESET_TOKEN_INVALID',
				'This password reset link is invalid or has expired.',
				400,
			);
		}
		assertPasswordPolicy(password, this.#policy().passwordMinLength);
		const accountId = await this.#repository.consumePasswordResetToken(
			hashSessionToken(token),
			this.#now(),
		);
		if (!accountId) {
			throw new AuthServiceError(
				'RESET_TOKEN_INVALID',
				'This password reset link is invalid or has expired.',
				400,
			);
		}
		const account = await this.#repository.findAccountCredentialById(accountId);
		if (!account || account.status !== 'active') {
			throw new AuthServiceError(
				'RESET_TOKEN_INVALID',
				'This password reset link is invalid or has expired.',
				400,
			);
		}
		await this.#repository.updatePasswordHash(
			accountId,
			await hashPassword(password, this.#passwordHash),
			false,
		);
		await this.#repository.deleteAccountSessions(accountId, null);
		await this.#repository.clearSignInFailures(normalizeEmail(account.email));
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.passwordResetCompleted,
			'account',
			account.accountId,
		);
	}

	async createTenantInvitation(
		actor: AuthActor,
		email: string,
		roleKey: string,
	): Promise<{ readonly id: string; readonly expiresAt: number }> {
		const normalized = normalizeEmail(email);
		if (
			normalized.length > 254 ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
		) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				'Enter a valid email address.',
				400,
			);
		}
		/* Owner elevation through invitations follows the same rule as member creation. */
		await this.#roleForAssignment(actor, validateRoleKey(roleKey));
		if (!this.#mailDelivery) {
			throw new AuthServiceError(
				'MAIL_NOT_CONFIGURED',
				'Email delivery is not configured for this deployment.',
				503,
			);
		}
		const invitation = await this.#mintTenantInvitation({
			tenantId: actor.tenantId,
			normalizedEmail: normalized,
			roleKey: roleKey.trim(),
			createdBy: actor.accountId,
		});
		try {
			await this.#mailDelivery.send({
				to: normalized,
				kind: 'tenant-invitation',
				url: invitation.url,
			});
		} catch {
			throw new AuthServiceError(
				'MAIL_DELIVERY_FAILED',
				'The invitation could not be delivered.',
				503,
			);
		}
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.invitationCreated,
			'invitation',
			invitation.id,
			{ role: roleKey.trim() },
		);
		return { id: invitation.id, expiresAt: invitation.expiresAt };
	}

	async acceptTenantInvitation(input: {
		readonly token: string;
		readonly displayName: string;
		readonly password: string;
	}): Promise<void> {
		if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) {
			throw new AuthServiceError(
				'INVITATION_INVALID',
				'This invitation is invalid or has expired.',
				400,
			);
		}
		const invitation = await this.#repository.consumeTenantInvitation(
			hashSessionToken(input.token),
			this.#now(),
		);
		if (!invitation)
			throw new AuthServiceError(
				'INVITATION_INVALID',
				'This invitation is invalid or has expired.',
				400,
			);
		const role = await this.#repository.findRoleByKey(
			invitation.tenantId,
			invitation.roleKey,
		);
		if (!role)
			throw new AuthServiceError(
				'INVITATION_INVALID',
				'This invitation is invalid or has expired.',
				400,
			);
		const existing = await this.#repository.findAccountByEmail(
			invitation.normalizedEmail,
		);
		if (existing) {
			if (
				await this.#repository.findAccountMembership(
					existing.accountId,
					invitation.tenantId,
				)
			) {
				throw new AuthServiceError(
					'INVITATION_INVALID',
					'This invitation is invalid or has expired.',
					400,
				);
			}
			await this.#repository.createMembershipInTenant({
				accountId: existing.accountId,
				tenantId: invitation.tenantId,
				role: invitation.roleKey,
				roleId: role.id,
				scopes: role.scopes,
				createdAt: this.#now(),
			});
		} else {
			await this.createTenantMember({
				tenantId: invitation.tenantId,
				email: invitation.email,
				displayName: input.displayName,
				password: input.password,
				role: invitation.roleKey,
			});
		}
		await this.#audit(
			invitation.tenantId,
			{
				kind: 'user',
				id: existing?.accountId ?? 'invited-account',
				label: invitation.email,
			},
			AUDIT_ACTIONS.invitationAccepted,
			'invitation',
			invitation.email,
		);
	}

	/* Operator provisioning. A deployment turns public sign-up off, so its first
	   workspace and every later colleague arrive through these calls instead.
	   They write the rows the HTTP paths write, audit trail included, and read
	   nothing from the sign-up setting. */
	async planWorkspaceProvision(
		input: WorkspaceProvisionInput,
	): Promise<WorkspaceProvisionPlan> {
		const operator = this.#identifier(input.operator, 'operator');
		const name = validateWorkspaceName(input.name);
		const slug = validateWorkspaceSlug(input.slug);
		const displayName = validateDisplayName(input.ownerDisplayName);
		const email = validateEmailAddress(input.ownerEmail);
		if (input.password !== undefined) {
			assertPasswordPolicy(input.password, this.#policy().passwordMinLength);
		}
		if (await this.#repository.isTenantSlugTaken(slug)) {
			throw new AuthServiceError(
				'WORKSPACE_SLUG_TAKEN',
				`A workspace with the id "${slug}" already exists.`,
				409,
			);
		}
		/* An operator holds the deployment shell already, so a precise refusal
		   reveals nothing the public sign-up response has to withhold. */
		if (await this.#repository.findAccountByEmail(email)) {
			throw new AuthServiceError(
				'ACCOUNT_EXISTS',
				`An account already exists for ${email}. Add that account to a workspace instead of creating a second one.`,
				409,
			);
		}
		return {
			workspace: { name, slug },
			owner: { email, displayName, role: 'owner', scopes: OWNER_SCOPES },
			credential: {
				kind:
					input.password === undefined
						? 'password-setup-link'
						: 'operator-password',
			},
			operator,
		};
	}

	async provisionWorkspace(
		input: WorkspaceProvisionInput,
	): Promise<ProvisionedWorkspace> {
		const plan = await this.planWorkspaceProvision(input);
		const actor = operatorActor(plan.operator);
		/* Without an operator-chosen password the row still needs a hash. A
		   discarded random one leaves the setup link as the only way in. */
		const passwordHash = await hashPassword(
			input.password ?? randomBytes(32).toString('base64url'),
			this.#passwordHash,
		);
		const tenantId = randomUUID();
		let owner: AccountCredential;
		try {
			owner = await this.#repository.createAccountWithTenant({
				accountId: randomUUID(),
				tenantId,
				email: plan.owner.email,
				normalizedEmail: plan.owner.email,
				passwordHash,
				displayName: plan.owner.displayName,
				organizationName: plan.workspace.name,
				organizationSlug: plan.workspace.slug,
				role: 'owner',
				scopes: OWNER_SCOPES,
				createdAt: this.#now(),
			});
		} catch (error) {
			if (error instanceof DuplicateAccountError) {
				throw new AuthServiceError('ACCOUNT_EXISTS', error.message, 409);
			}
			if (error instanceof DuplicateTenantSlugError) {
				throw new AuthServiceError('WORKSPACE_SLUG_TAKEN', error.message, 409);
			}
			throw error;
		}
		await this.#audit(
			tenantId,
			actor,
			AUDIT_ACTIONS.workspaceProvisioned,
			'tenant',
			tenantId,
			{ slug: plan.workspace.slug, name: plan.workspace.name },
		);
		await this.#audit(
			tenantId,
			actor,
			AUDIT_ACTIONS.memberCreated,
			'account',
			owner.accountId,
			{ email: owner.email, role: owner.role },
		);
		return {
			workspace: {
				tenantId,
				name: plan.workspace.name,
				slug: plan.workspace.slug,
			},
			owner: {
				accountId: owner.accountId,
				email: owner.email,
				displayName: owner.displayName,
				role: owner.role,
				scopes: owner.scopes,
			},
			credential:
				input.password === undefined
					? await this.#issuePasswordSetupLink(owner, actor)
					: { kind: 'operator-password' },
			operator: plan.operator,
		};
	}

	/* The operator holds a terminal on the deployment, so the link is returned
	   to the command rather than posted. The public reset path cannot serve this:
	   it needs a mail adapter, and a deployment has none until someone composes
	   one. */
	async #issuePasswordSetupLink(
		account: AccountCredential,
		actor: Actor,
	): Promise<OperatorCredential> {
		const reset = await this.#mintPasswordResetToken(
			account.accountId,
			OPERATOR_SETUP_TTL_MS,
		);
		await this.#audit(
			account.tenantId,
			actor,
			AUDIT_ACTIONS.passwordResetRequested,
			'account',
			account.accountId,
		);
		return { kind: 'password-setup-link', ...reset };
	}

	async planMemberProvision(
		input: MemberProvisionInput,
	): Promise<MemberProvisionPlan> {
		const operator = this.#identifier(input.operator, 'operator');
		const email = validateEmailAddress(input.email);
		const roleKey = validateRoleKey(input.role);
		const workspace = await this.findTenant(input.workspace);
		if (!workspace) {
			throw new AuthServiceError(
				'TENANT_NOT_FOUND',
				`No workspace matches "${input.workspace}".`,
				404,
			);
		}
		const role = await this.#repository.findRoleByKey(
			workspace.tenantId,
			roleKey,
		);
		if (!role) {
			throw new AuthServiceError(
				'ROLE_NOT_FOUND',
				`The workspace has no role "${roleKey}".`,
				404,
			);
		}
		const account = await this.#repository.findAccountByEmail(email);
		if (
			account &&
			(await this.#repository.findAccountMembership(
				account.accountId,
				workspace.tenantId,
			))
		) {
			throw new AuthServiceError(
				'MEMBER_EXISTS',
				`${email} is already a member of "${workspace.slug}".`,
				409,
			);
		}
		return {
			workspace,
			email,
			role,
			action: account ? 'membership' : 'invitation',
			account: account
				? {
						accountId: account.accountId,
						email: account.email,
						displayName: account.displayName,
					}
				: null,
			credential: {
				kind: account ? 'existing-password' : 'invitation-link',
			},
			operator,
		};
	}

	async provisionMember(
		input: MemberProvisionInput,
	): Promise<ProvisionedMember> {
		const plan = await this.planMemberProvision(input);
		const actor = operatorActor(plan.operator);
		if (plan.account) {
			const membership = await this.#repository.createMembershipInTenant({
				accountId: plan.account.accountId,
				tenantId: plan.workspace.tenantId,
				role: plan.role.key,
				roleId: plan.role.id,
				scopes: plan.role.scopes,
				createdAt: this.#now(),
			});
			await this.#audit(
				plan.workspace.tenantId,
				actor,
				AUDIT_ACTIONS.memberCreated,
				'account',
				membership.accountId,
				{ email: membership.email, role: plan.role.key },
			);
			return {
				workspace: plan.workspace,
				email: membership.email,
				role: plan.role.key,
				scopes: membership.scopes,
				action: 'membership',
				accountId: membership.accountId,
				invitationId: null,
				credential: { kind: 'existing-password' },
				operator: plan.operator,
			};
		}
		/* Minted here rather than through createTenantInvitation, which cannot
		   serve an operator: it refuses without a mail adapter and hands its
		   token only to that adapter. */
		const invitation = await this.#mintTenantInvitation({
			tenantId: plan.workspace.tenantId,
			normalizedEmail: plan.email,
			roleKey: plan.role.key,
			createdBy: plan.operator,
		});
		await this.#audit(
			plan.workspace.tenantId,
			actor,
			AUDIT_ACTIONS.invitationCreated,
			'invitation',
			invitation.id,
			{ role: plan.role.key },
		);
		return {
			workspace: plan.workspace,
			email: plan.email,
			role: plan.role.key,
			scopes: plan.role.scopes,
			action: 'invitation',
			accountId: null,
			invitationId: invitation.id,
			credential: {
				kind: 'invitation-link',
				url: invitation.url,
				expiresAt: invitation.expiresAt,
			},
			operator: plan.operator,
		};
	}

	async enrollTotp(
		accountId: string,
		issuer = 'Flowdular',
	): Promise<{
		readonly secret: string;
		readonly otpauthUrl: string;
		readonly recoveryCodes: readonly string[];
	}> {
		const account = await this.#repository.findAccountCredentialById(
			this.#identifier(accountId, 'accountId'),
		);
		if (!account)
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not available.',
				404,
			);
		if (
			(await this.#repository.findMfaTotp(account.accountId))?.confirmedAt !=
			null
		) {
			throw new AuthServiceError(
				'MFA_ALREADY_CONFIGURED',
				'Multi-factor authentication is already enabled for this account.',
				409,
			);
		}
		const secret = createTotpSecret();
		const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
			randomBytes(10).toString('hex').toUpperCase(),
		);
		const now = this.#now();
		await this.#repository.upsertMfaTotp(
			account.accountId,
			encryptMfaSecret(secret, this.#mfaEncryptionKey),
			now,
		);
		await this.#repository.replaceMfaRecoveryCodes(
			account.accountId,
			recoveryCodes.map(hashSessionToken),
			now,
		);
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.mfaEnrolled,
			'account',
			account.accountId,
		);
		return {
			secret,
			otpauthUrl: `otpauth://totp/${encodeURIComponent(`${issuer}:${account.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
			recoveryCodes,
		};
	}

	async mfaStatus(accountId: string): Promise<MfaStatus> {
		const account = await this.#repository.findAccountCredentialById(
			this.#identifier(accountId, 'accountId'),
		);
		if (!account)
			throw new AuthServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not available.',
				404,
			);
		const factor = await this.#repository.findMfaTotp(account.accountId);
		return {
			available: this.#mfaEncryptionKey !== undefined,
			enrolled: factor?.confirmedAt != null,
			pending: factor !== null && factor.confirmedAt === null,
		};
	}

	async confirmTotp(accountId: string, code: string): Promise<void> {
		const account = await this.#repository.findAccountCredentialById(
			this.#identifier(accountId, 'accountId'),
		);
		const record = account
			? await this.#repository.findMfaTotp(account.accountId)
			: null;
		if (
			!account ||
			!record ||
			!verifyTotp(
				decryptMfaSecret(record.secretCiphertext, this.#mfaEncryptionKey),
				code,
				this.#now(),
			)
		) {
			throw new AuthServiceError(
				'MFA_CODE_INVALID',
				'The authentication code is invalid.',
				400,
			);
		}
		await this.#repository.confirmMfaTotp(account.accountId, this.#now());
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.mfaConfirmed,
			'account',
			account.accountId,
		);
	}

	async completeMfaChallenge(
		token: string,
		code?: string,
		recoveryCode?: string,
	): Promise<IssuedSession> {
		if (!/^[A-Za-z0-9_-]{43}$/.test(token))
			throw new AuthServiceError(
				'MFA_CHALLENGE_INVALID',
				'The sign-in challenge is invalid or has expired.',
				401,
			);
		const challenge = await this.#repository.consumeMfaChallenge(
			hashSessionToken(token),
			this.#now(),
		);
		if (!challenge)
			throw new AuthServiceError(
				'MFA_CHALLENGE_INVALID',
				'The sign-in challenge is invalid or has expired.',
				401,
			);
		const account = await this.#repository.findAccountMembership(
			challenge.accountId,
			challenge.tenantId,
		);
		const record = account
			? await this.#repository.findMfaTotp(account.accountId)
			: null;
		const valid =
			account &&
			record?.confirmedAt !== null &&
			record !== null &&
			((typeof code === 'string' &&
				verifyTotp(
					decryptMfaSecret(record.secretCiphertext, this.#mfaEncryptionKey),
					code,
					this.#now(),
				)) ||
				(typeof recoveryCode === 'string' &&
					/* Twelve-character codes were issued before 0.8.0. Keep them
					   redeemable while all newly issued codes carry 80 bits. */
					/^(?:[A-F0-9]{12}|[A-F0-9]{20})$/.test(recoveryCode) &&
					(await this.#repository.consumeMfaRecoveryCode(
						account.accountId,
						hashSessionToken(recoveryCode),
					))));
		if (!valid)
			throw new AuthServiceError(
				'MFA_CODE_INVALID',
				'The authentication code is invalid.',
				401,
			);
		const issued = await this.#issue(account);
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.mfaChallengeSucceeded,
			'session',
			issued.sessionId,
		);
		return issued;
	}

	async signInVerifiedExternalEmail(
		email: string,
	): Promise<IssuedSession | MfaChallenge> {
		const account = await this.#repository.findAccountByEmail(
			normalizeEmail(email),
		);
		if (!account || account.status !== 'active')
			throw this.#invalidCredentials();
		if (
			(await this.#repository.findMfaTotp(account.accountId))?.confirmedAt !=
			null
		)
			return this.#issueMfaChallenge(account);
		const issued = await this.#issue(account);
		await this.#audit(
			account.tenantId,
			{ kind: 'user', id: account.accountId, label: account.email },
			AUDIT_ACTIONS.signInSucceeded,
			'session',
			issued.sessionId,
			{ via: 'oidc' },
		);
		return issued;
	}

	async resolveSession(token: string | null): Promise<AuthSession | null> {
		if (!token) return null;
		return this.#repository.findSession(
			hashSessionToken(token),
			this.#now(),
			this.#policy().sessionIdleMs,
			SESSION_TOUCH_INTERVAL_MS,
		);
	}

	async listSessions(accountId: string): Promise<readonly SessionSummary[]> {
		return this.#repository.listAccountSessions(
			this.#identifier(accountId, 'accountId'),
			this.#now(),
		);
	}

	async revokeOwnSession(
		session: AuthSession,
		sessionId: string,
	): Promise<void> {
		const removed = await this.#repository.deleteSessionById(
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
		await this.#audit(
			session.principal.tenantId,
			{
				kind: 'user',
				id: session.principal.accountId,
				label: session.principal.email,
			},
			AUDIT_ACTIONS.sessionRevoked,
			'session',
			sessionId,
		);
	}

	async revokeMemberSessions(
		actor: AuthActor,
		accountId: string,
	): Promise<number> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		const before = (
			await this.#repository.listAccountSessions(target.accountId, this.#now())
		).length;
		await this.#repository.deleteAccountSessions(target.accountId, null);
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.sessionRevoked,
			'account',
			target.accountId,
			{ sessions: before },
		);
		return before;
	}

	async deleteExpiredSessions(): Promise<number> {
		return this.#repository.deleteExpiredSessions(this.#now());
	}

	async recordSettingsUpdate(
		actor: AuthActor,
		moduleId: string,
		key: string,
		cleared: boolean,
	): Promise<void> {
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.settingsUpdated,
			'setting',
			`${moduleId}.${key}`,
			{ cleared },
		);
	}

	async queryAudit(query: AuditQuery): Promise<AuditActorPage> {
		const limit = Math.min(
			Math.max(1, Math.trunc(query.limit)),
			MAX_AUDIT_PAGE,
		);
		const events = await this.#repository.queryAudit({
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
		const current = await this.resolveSession(token);
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
		const account = await this.#repository.findAccountMembership(
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
		await this.#repository.deleteSession(hashSessionToken(token));
		return this.#issue(account);
	}

	/* API tokens are machine credentials for clients that cannot hold a browser
	   session, such as a sandbox connected to a remote deployment. Only the hash
	   is stored, the raw value is returned exactly once, and effective authority
	   is always re-intersected with the live membership scopes. */
	async issueApiToken(raw: CreateApiTokenInput): Promise<IssuedApiToken> {
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
		const membership = await this.#repository.findAccountMembership(
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
		const record = await this.#repository.createApiToken({
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
		await this.#audit(
			tenantId,
			{ kind: 'user', id: createdBy, label: membership.email },
			AUDIT_ACTIONS.tokenIssued,
			'api-token',
			record.id,
			{ label, scopes },
		);
		return { record, token };
	}

	async listApiTokens(tenantId: string): Promise<readonly ApiTokenRecord[]> {
		return this.#repository.listApiTokens(
			this.#identifier(tenantId, 'tenantId'),
		);
	}

	async revokeApiToken(
		tenantId: string,
		id: string,
		revokedBy: string,
	): Promise<ApiTokenRecord> {
		const record = await this.#repository.revokeApiToken(
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
		await this.#audit(
			record.tenantId,
			{ kind: 'user', id: revokedBy, label: revokedBy },
			AUDIT_ACTIONS.tokenRevoked,
			'api-token',
			record.id,
			{ label: record.label },
		);
		return record;
	}

	async resolveApiToken(raw: string | null): Promise<AuthPrincipal | null> {
		if (!raw || !API_TOKEN_PATTERN.test(raw)) return null;
		const record = await this.#repository.findApiTokenByHash(
			hashSessionToken(raw),
		);
		if (!record || record.revokedAt !== null) return null;
		const now = this.#now();
		if (record.expiresAt !== null && record.expiresAt <= now) return null;
		const membership = await this.#repository.findAccountMembership(
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
			await this.#repository.touchApiToken(record.tenantId, record.id, now);
		}
		return {
			accountId: membership.accountId,
			tenantId: membership.tenantId,
			email: membership.email,
			displayName: membership.displayName,
			role: membership.role,
			scopes,
			tenants: await this.#repository.listTenantAccess(membership.accountId),
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

	async signOut(token: string): Promise<void> {
		const session = await this.resolveSession(token);
		await this.#repository.deleteSession(hashSessionToken(token));
		if (session) {
			await this.#audit(
				session.principal.tenantId,
				{
					kind: 'user',
					id: session.principal.accountId,
					label: session.principal.email,
				},
				AUDIT_ACTIONS.signOut,
				'session',
				session.sessionId,
			);
		}
	}
}
