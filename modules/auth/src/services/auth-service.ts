import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
	serviceActor,
	userActor,
	type Actor,
	type ModuleSettingChange,
	type UserActor,
} from '@flowdular/kernel';
import type { ErrorSink, ModuleMetrics } from '@flowdular/server';
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
	CreateTenantMemberWithoutPasswordInput,
	IssuedApiToken,
	IssuedSession,
	MembershipStatus,
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
	IdentityProviderService,
	PROVIDER_AUDIT_ACTIONS,
	type OidcDiscoveryPort,
} from './identity-provider-service.ts';
import {
	createProviderSecretVault,
	type ProviderSecretVault,
} from './provider-secrets.ts';
import {
	DEFAULT_PASSWORD_HASH_OPTIONS,
	hashPassword,
	passwordIsSet,
	UNUSABLE_PASSWORD_HASH,
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
	type ExternalIdentityPage,
	type TenantMember,
	type TenantMemberPage,
	type TenantSummary,
} from './repository.ts';
import type { AuthMailDelivery } from './mail-delivery.ts';
import {
	createMfaSecretVault,
	createTotpSecret,
	verifyTotp,
	type MfaSecretVault,
} from './totp.ts';
import {
	assertPasswordPolicy,
	normalizeEmail,
	validateCreateTenantMember,
	validateCreateTenantMemberWithoutPassword,
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
	/**
	 * Keys a rotation has not finished retiring. They open stored factors that
	 * were sealed before the rotation, and nothing is ever written with them.
	 */
	readonly mfaPreviousEncryptionKeys?: readonly string[];
	/**
	 * Verifies an issuer through its discovery document when a workspace saves
	 * a provider. The server layer installs the HTTP adapter; without one, a
	 * save is refused instead of trusting an unverified issuer.
	 */
	readonly oidcDiscovery?: OidcDiscoveryPort;
	/**
	 * Drops the ID token verifier's cached key set for a provider whose row
	 * changed. The server layer installs the verifier it serves with; a
	 * composition without one caches nothing to invalidate.
	 */
	readonly forgetProviderKeys?: (providerId: string) => void;
	/** Deployment-owned delivery adapter. auth.core never selects an email vendor. */
	readonly mailDelivery?: AuthMailDelivery;
	/**
	 * The locale a workspace's messages are worded in. The server resolves it
	 * from the workspace's defaultLocale setting; without one every message is
	 * English.
	 */
	readonly mailLocale?: (tenantId: string) => Promise<string> | string;
	/** Public origin used to form opaque, one-time delivery links. */
	readonly publicBaseUrl?: string;
	/** Counts the audit writes that failed; a failed write never fails its operation. */
	readonly metrics?: ModuleMetrics;
	/** Receives a failed audit write as a name and a module, never as the driver's words. */
	readonly errorSink?: ErrorSink;
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

/** What a sign-in through a tenant-owned provider needs about the workspace. */
export interface TenantProviderSignIn {
	readonly tenantId: string;
	readonly jitEnabled: boolean;
	readonly allowedDomains: readonly string[];
	readonly jitRole: string;
}

/* A workspace saving a provider verifies its issuer through discovery, which is
   an outbound request the server layer owns. Without that adapter the save is
   refused rather than trusting the issuer a request supplied. */
function discoveryUnavailable(): AuthServiceError {
	return new AuthServiceError(
		'PROVIDER_DISCOVERY_UNAVAILABLE',
		'Issuer discovery is not available in this composition.',
		503,
	);
}

/* A provisioned account has only the address the provider verified. The local
   part is the readable half of it and is what the member sees until they
   change it. */
function displayNameFromEmail(email: string): string {
	const local = email.slice(0, email.lastIndexOf('@'));
	const candidate = local.length >= 2 ? local : email;
	return candidate.slice(0, 80);
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

/**
 * Addresses one `findTenantMembersByEmail` call may name. A bulk caller splits
 * a larger batch, so the statement never carries an unbounded list and a
 * workspace of unknown size is never listed to answer a handful of addresses.
 */
export const TENANT_MEMBER_LOOKUP_LIMIT = 500;

/** Members one `searchTenantMembers` call may answer. */
export const TENANT_MEMBER_SEARCH_LIMIT = 500;

/** Members one paged `listTenantMembers` call may answer. */
export const TENANT_MEMBER_PAGE_LIMIT = 500;

/** Bindings one `listExternalIdentities` call may answer. */
export const EXTERNAL_IDENTITY_PAGE_LIMIT = 500;

/** Characters a search term may carry; a longer one matches nothing useful. */
export const TENANT_MEMBER_SEARCH_TERM_LENGTH = 200;

/* The LIKE wildcards, so a term a person typed is matched literally. The
   statements that use it declare ESCAPE '\'. */
function escapeLikeTerm(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

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
	mfaReset: 'auth.mfa.reset',
	tenantRenamed: 'auth.tenant.renamed',
	workspaceProvisioned: 'auth.workspace.provisioned',
	memberCreated: 'users.member.created',
	memberUpdated: 'users.member.updated',
	memberStatus: 'users.member.status',
	memberProvisioned: 'auth.member.provisioned',
	jitRefused: 'auth.jit.refused',
	membershipStatus: 'auth.membership.status',
	providerCreated: PROVIDER_AUDIT_ACTIONS.created,
	providerUpdated: PROVIDER_AUDIT_ACTIONS.updated,
	providerStatusChanged: PROVIDER_AUDIT_ACTIONS.status,
	providerSecretRotated: PROVIDER_AUDIT_ACTIONS.secretRotated,
	providerDeleted: PROVIDER_AUDIT_ACTIONS.deleted,
	memberRemoved: 'users.member.removed',
	memberPasswordReset: 'users.member.password-reset',
	memberScopes: 'users.member.scopes',
	memberRole: 'users.member.role',
	roleCreated: 'auth.role.created',
	roleUpdated: 'auth.role.updated',
	roleDeleted: 'auth.role.deleted',
	settingsUpdated: 'settings.updated',
	settingsFlagChanged: 'settings.flag.changed',
});

export const AUDIT_ACTION_LIST = Object.freeze(Object.values(AUDIT_ACTIONS));

/* The actor an audit row records. A kernel service actor always names its
   configuring user; a provider row stores none, so the trail admits a service
   actor whose configuring user is unknown and persists it as null. */
interface ServiceAuditActor {
	readonly kind: 'service';
	readonly id: string;
	readonly label: string;
	readonly configuredBy: UserActor | null;
}

type AuditActor = Actor | ServiceAuditActor;

/* An operator command runs from a deployment shell and belongs to no account.
   The shell is the service and the person at it, whose identifier carries the
   cli: prefix the label filter can search for, is who configured it. */
function operatorActor(operator: string): Actor {
	return serviceActor({
		serviceId: operator,
		label: operator,
		configuredBy: { kind: 'user', id: operator, label: operator },
	});
}

/* A refused just-in-time sign-in belongs to no account of this workspace, so
   the provider that asserted the identity is the actor and the address it
   reported never reaches the trail. */
function providerActor(provider: string): ServiceAuditActor {
	return {
		kind: 'service',
		id: `oidc:${provider}`,
		label: `oidc:${provider}`,
		configuredBy: null,
	};
}

function member(account: AccountCredential, createdAt: number): TenantMember {
	return {
		accountId: account.accountId,
		email: account.email,
		displayName: account.displayName,
		role: account.role,
		roleId: account.roleId,
		status: account.status,
		membershipStatus: account.membershipStatus,
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
	readonly #mfaPreviousEncryptionKeys: readonly string[];
	#mfaVault: MfaSecretVault | undefined;
	#providerSecretVault: ProviderSecretVault | undefined;
	#identityProviders: IdentityProviderService | undefined;
	readonly #oidcDiscovery: OidcDiscoveryPort;
	readonly #forgetProviderKeys: (providerId: string) => void;
	readonly #mailDelivery: AuthMailDelivery | undefined;
	readonly #mailLocale: (tenantId: string) => Promise<string> | string;
	readonly #publicBaseUrl: string;
	readonly #metrics: ModuleMetrics | undefined;
	readonly #errorSink: ErrorSink | undefined;

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
		this.#mfaPreviousEncryptionKeys = options.mfaPreviousEncryptionKeys ?? [];
		this.#oidcDiscovery =
			options.oidcDiscovery ?? (() => Promise.reject(discoveryUnavailable()));
		this.#forgetProviderKeys = options.forgetProviderKeys ?? (() => undefined);
		this.#mailDelivery = options.mailDelivery;
		this.#mailLocale = options.mailLocale ?? (() => 'en');
		this.#publicBaseUrl = (options.publicBaseUrl ?? 'http://localhost').replace(
			/\/$/,
			'',
		);
		this.#metrics = options.metrics;
		this.#errorSink = options.errorSink;
	}

	get policy(): AuthPolicy {
		return this.#policy();
	}

	/* Audit rows are evidence, never a reason to fail the operation they
	   describe; a failing write is reported and swallowed. */
	async #audit(
		tenantId: string,
		actor: AuditActor,
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
				configuredBy: actor.kind === 'service' ? actor.configuredBy : null,
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
			this.#metrics?.counter('audit_write_failures_total', { action });
			this.#errorSink?.report({
				at: this.#now(),
				name: 'AuditWriteFailed',
				module: 'auth.core',
				message: `Audit write failed for ${action}.`,
			});
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
		const account = await this.#signInAccount(input);
		if (!account) {
			await hashPassword(input.password, this.#passwordHash);
			await this.#recordFailure(input.email, null, context);
			throw this.#invalidCredentials();
		}
		/* An account created without a password answers exactly as an unknown
		   address does, down to burning the same derivation: a distinct code here
		   would tell an attacker which addresses are registered and not yet
		   activated, which is the set most worth attacking. PASSWORD_NOT_SET is
		   reported where the caller is already authenticated as the account. */
		if (!passwordIsSet(account.passwordHash)) {
			await hashPassword(input.password, this.#passwordHash);
			await this.#recordFailure(input.email, account, context);
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

	/* The workspace the sign-in screen names is the one the session opens in:
	   the membership has to exist there and be active. An unknown workspace and
	   a membership the account does not hold answer as a wrong password does,
	   so the form never reports which workspaces hold an address. Without a
	   named workspace the oldest membership answers, exactly as before. */
	async #signInAccount(input: SignInInput): Promise<AccountCredential | null> {
		if (input.workspace === undefined) {
			return this.#repository.findAccountByEmail(input.email);
		}
		const tenant = await this.findTenant(input.workspace);
		if (!tenant) return null;
		const identity = await this.#repository.findAccountIdentity(input.email);
		if (!identity) return null;
		const membership = await this.#repository.findAccountMembership(
			identity.accountId,
			tenant.tenantId,
		);
		return membership?.membershipStatus === 'active' ? membership : null;
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

	listTenantMembers(tenantId: string): Promise<readonly TenantMember[]>;
	listTenantMembers(
		tenantId: string,
		page: { readonly cursor?: string | null; readonly limit: number },
	): Promise<TenantMemberPage>;
	/**
	 * The members of one workspace. The unbounded call answers the whole roll
	 * ordered by display name and stays what every caller holding a workspace of
	 * known size already reads. The paged call walks the same members by account
	 * id, one bounded page and the cursor of the next, for a caller that must
	 * not read a workspace of unknown size in one statement.
	 */
	async listTenantMembers(
		tenantId: string,
		page?: { readonly cursor?: string | null; readonly limit: number },
	): Promise<readonly TenantMember[] | TenantMemberPage> {
		if (page === undefined) return this.#repository.listTenantMembers(tenantId);
		const limit = this.#pageLimit(page.limit, TENANT_MEMBER_PAGE_LIMIT);
		const members = await this.#repository.listTenantMembersPage(
			this.#identifier(tenantId, 'tenantId'),
			page.cursor ?? '',
			limit + 1,
		);
		const answered = members.slice(0, limit);
		const last = answered[answered.length - 1];
		return {
			members: answered,
			nextCursor: members.length > limit && last ? last.accountId : null,
		};
	}

	/**
	 * The identity bindings this workspace's own providers assert about its
	 * members, one bounded page per call. A binding names the account, the
	 * provider key, the subject the provider keeps stable and when it was first
	 * recorded; no token, secret, ciphertext or fingerprint is part of one, and
	 * neither is the address the provider reported. A binding a platform
	 * provider made carries no workspace and is not answered here. The
	 * permission a reader needs is the calling module's to enforce; this is
	 * scoped to the workspace it is given and nothing wider.
	 */
	async listExternalIdentities(
		tenantId: string,
		page: { readonly cursor?: string | null; readonly limit: number },
	): Promise<ExternalIdentityPage> {
		const limit = this.#pageLimit(page.limit, EXTERNAL_IDENTITY_PAGE_LIMIT);
		/* A provider key carries no colon, so the first one separates the pair; a
		   cursor that is not one starts the walk over rather than half-reading a
		   position, the way a malformed audit cursor narrows nothing. */
		const separator = page.cursor?.indexOf(':') ?? -1;
		const after =
			page.cursor && separator > 0
				? {
						provider: page.cursor.slice(0, separator),
						subject: page.cursor.slice(separator + 1),
					}
				: { provider: '', subject: '' };
		const identities = await this.#repository.listExternalIdentitiesPage(
			this.#identifier(tenantId, 'tenantId'),
			after,
			limit + 1,
		);
		const answered = identities.slice(0, limit);
		const last = answered[answered.length - 1];
		return {
			identities: answered,
			nextCursor:
				identities.length > limit && last
					? `${last.provider}:${last.subject}`
					: null,
		};
	}

	/**
	 * The members of one workspace holding any of these addresses. The natural
	 * key a bulk caller resolves per batch, answered by the database rather than
	 * by listing the workspace and matching in memory. Addresses are folded the
	 * way auth.core folds a stored address, so the caller passes what a person
	 * typed. An address the workspace does not hold is simply absent from the
	 * answer, and an account that exists in another workspace stays invisible
	 * here.
	 */
	async findTenantMembersByEmail(
		tenantId: string,
		emails: readonly string[],
	): Promise<readonly TenantMember[]> {
		if (emails.length > TENANT_MEMBER_LOOKUP_LIMIT) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`At most ${TENANT_MEMBER_LOOKUP_LIMIT} addresses can be looked up at once.`,
				400,
			);
		}
		const normalized = [
			...new Set(emails.map(normalizeEmail).filter((email) => email !== '')),
		];
		return this.#repository.findTenantMembersByEmail(
			this.#identifier(tenantId, 'tenantId'),
			normalized,
		);
	}

	/**
	 * Members of one workspace whose display name or address starts with the
	 * term, cut to `limit` in the database. The caller ranks what comes back;
	 * this only bounds what a search reads.
	 */
	async searchTenantMembers(
		tenantId: string,
		input: { readonly query: string; readonly limit: number },
	): Promise<readonly TenantMember[]> {
		const term = normalizeEmail(input.query);
		if (term.length === 0 || term.length > TENANT_MEMBER_SEARCH_TERM_LENGTH) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`Search term must contain 1 to ${TENANT_MEMBER_SEARCH_TERM_LENGTH} characters.`,
				400,
			);
		}
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > TENANT_MEMBER_SEARCH_LIMIT
		) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`Limit must be 1 to ${TENANT_MEMBER_SEARCH_LIMIT}.`,
				400,
			);
		}
		return this.#repository.searchTenantMembers(
			this.#identifier(tenantId, 'tenantId'),
			escapeLikeTerm(term),
			input.limit,
		);
	}

	/* A dependent module that needs the role and scopes of one account asks for
	   that account: reading the whole workspace to find it costs the roll on
	   every decision a member takes. */
	async findTenantMember(
		tenantId: string,
		accountId: string,
	): Promise<TenantMember | null> {
		return this.#repository.findTenantMember(tenantId, accountId);
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
		/* The caller is already authenticated as this account, so naming the cause
		   reveals nothing it does not already know, and "the current password is
		   incorrect" would be a dead end for a member who never had one. */
		if (!passwordIsSet(account.passwordHash)) {
			throw new AuthServiceError(
				'PASSWORD_NOT_SET',
				'This account has no password yet. Use the password reset link to set the first one.',
				409,
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
		assertPasswordPolicy(
			input.newPassword,
			this.#policy().passwordMinLength,
			account.email,
		);
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
		return this.#createTenantMember(
			input,
			actor,
			await hashPassword(input.password, this.#passwordHash),
		);
	}

	/**
	 * A member who holds no password at all. The account stores the unusable
	 * credential marker rather than a secret nobody keeps: no password can match
	 * it, so a sign-in by password is refused, and the member reaches the
	 * workspace through the reset flow, an administrative temporary password or
	 * an external identity. A bulk creator calls this instead of drawing a random
	 * secret it immediately throws away.
	 */
	async createTenantMemberWithoutPassword(
		raw: CreateTenantMemberWithoutPasswordInput,
		actor: AuthActor | null = null,
	): Promise<TenantMember> {
		return this.#createTenantMember(
			validateCreateTenantMemberWithoutPassword(raw),
			actor,
			UNUSABLE_PASSWORD_HASH,
		);
	}

	async #createTenantMember(
		input: CreateTenantMemberWithoutPasswordInput,
		actor: AuthActor | null,
		passwordHash: string,
	): Promise<TenantMember> {
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
					/* Only the credential-less creation is named, so the trail of an
					   ordinary one keeps the shape it had and carries no word about
					   a secret at all. */
					passwordHash === UNUSABLE_PASSWORD_HASH
						? { email: account.email, role: input.role, credential: 'none' }
						: { email: account.email, role: input.role },
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

	/* `counted` says whether the target is one of the active owners
	   countActiveOwners still counts, which is what makes `<= 1` mean "the last
	   one". A caller that changes the membership alone must not read the account
	   block as the membership's own state, or disabling an owner whose
	   membership is already disabled would answer LAST_OWNER instead of doing
	   nothing. */
	async #assertOwnerRemains(
		tenantId: string,
		target: AccountCredential,
		counted = target.status === 'active',
	): Promise<void> {
		if (
			target.role === 'owner' &&
			counted &&
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
		assertPasswordPolicy(
			temporaryPassword,
			this.#policy().passwordMinLength,
			target.email,
		);
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
		/* A provider provisions into a role by key, and the key is all the row
		   holds. Deleting the role behind it would leave every just-in-time
		   sign-in through that provider refusing silently, so the provider is
		   pointed elsewhere first. */
		const named = (
			await this.#repository.listIdentityProviders(actor.tenantId)
		).find((provider) => provider.jitRole === role.key);
		if (named) {
			throw new AuthServiceError(
				'ROLE_NAMED_BY_PROVIDER',
				`The identity provider ${named.key} provisions members into this role. Point it at another role first.`,
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
		if (!account) return;
		if (!this.#mailDelivery) {
			/* The client still gets the non-enumerating success, so the deployment
			   log is the only place this dead end is visible. The address stays out
			   of it. */
			console.warn(
				'[auth.core] mail transport is none; password reset for an existing account was not delivered',
			);
			return;
		}
		const reset = await this.#mintPasswordResetToken(
			account.accountId,
			PASSWORD_RESET_TTL_MS,
		);
		try {
			await this.#mailDelivery.send(
				{ to: account.email, kind: 'password-reset', url: reset.url },
				await this.#mailLocale(account.tenantId),
			);
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
		const tokenHash = hashSessionToken(token);
		const named = await this.#repository.findPasswordResetTokenAccount(
			tokenHash,
			this.#now(),
		);
		const account = named
			? await this.#repository.findAccountCredentialById(named)
			: null;
		if (!account || account.status !== 'active') {
			throw new AuthServiceError(
				'RESET_TOKEN_INVALID',
				'This password reset link is invalid or has expired.',
				400,
			);
		}
		/* The whole policy, including the address rule, runs on the account the
		   link names before anything spends it: a refused password leaves the
		   link usable instead of stranding the visitor with a dead one. */
		assertPasswordPolicy(
			password,
			this.#policy().passwordMinLength,
			account.email,
		);
		/* Claiming the token is still one statement, so two submissions of the
		   same link cannot both change the password. */
		const accountId = await this.#repository.consumePasswordResetToken(
			tokenHash,
			this.#now(),
		);
		if (!accountId) {
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
			await this.#mailDelivery.send(
				{ to: normalized, kind: 'tenant-invitation', url: invitation.url },
				await this.#mailLocale(actor.tenantId),
			);
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
			assertPasswordPolicy(
				input.password,
				this.#policy().passwordMinLength,
				email,
			);
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

	/* Built on first use, so a deployment that configures no MFA key still
	   constructs the service and an unusable key is refused where a factor is
	   actually sealed or opened, with MFA_NOT_CONFIGURED. */
	#vault(): MfaSecretVault {
		return (this.#mfaVault ??= createMfaSecretVault(
			this.#mfaEncryptionKey,
			this.#mfaPreviousEncryptionKeys,
		));
	}

	/* The same deployment keys under a provider-specific context, refused with
	   PROVIDER_KEY_REQUIRED where a provider secret is actually sealed. */
	#providerVault(): ProviderSecretVault {
		return (this.#providerSecretVault ??= createProviderSecretVault(
			this.#mfaEncryptionKey,
			this.#mfaPreviousEncryptionKeys,
		));
	}

	/** Tenant-owned identity providers of the workspaces this service serves. */
	get identityProviders(): IdentityProviderService {
		return (this.#identityProviders ??= new IdentityProviderService({
			repository: this.#repository,
			vault: () => this.#providerVault(),
			now: this.#now,
			discover: this.#oidcDiscovery,
			forgetKeys: (providerId) => this.#forgetProviderKeys(providerId),
			audit: (tenantId, actor, action, subjectType, subjectId, metadata) =>
				this.#audit(
					tenantId,
					actor,
					action,
					subjectType,
					subjectId,
					metadata ?? {},
				),
		}));
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
			this.#vault().seal(secret),
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

	/** Whether the account holds a confirmed second factor; one indexed read. */
	async hasConfirmedMfa(accountId: string): Promise<boolean> {
		return this.#repository.hasConfirmedMfaTotp(
			this.#identifier(accountId, 'accountId'),
		);
	}

	/* An administrator clears a lost factor. The target is resolved inside the
	   acting workspace, so an account that belongs only to another workspace
	   answers exactly as an unknown one does. */
	async resetMemberMfa(actor: AuthActor, accountId: string): Promise<void> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		await this.#repository.deleteMfaEnrolment(target.accountId);
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.mfaReset,
			'account',
			target.accountId,
			{ email: target.email },
		);
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
				this.#vault().open(record.secretCiphertext, record.keyId),
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
					this.#vault().open(record.secretCiphertext, record.keyId),
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

	/* The provider subject is the identity; the address it reports only
	   bootstraps the first link. Resolving by subject afterwards is what keeps a
	   reassigned address at the provider from reaching another account here. */
	async signInExternalIdentity(input: {
		readonly provider: string;
		readonly subject: string;
		readonly email: string;
		/**
		 * Present when a tenant-owned provider asserted the identity: the binding
		 * lives in that workspace, the session opens in that workspace, and
		 * nothing the provider says reaches another one.
		 */
		readonly workspace?: TenantProviderSignIn;
	}): Promise<IssuedSession | MfaChallenge> {
		const provider = this.#identifier(input.provider, 'provider');
		const subject = this.#identifier(input.subject, 'subject');
		const workspace = input.workspace ?? null;
		const tenantId = workspace?.tenantId ?? null;
		const linkedAccountId = await this.#repository.findExternalIdentity(
			provider,
			subject,
			tenantId,
		);
		const account = linkedAccountId
			? await this.#resolveLinkedAccount(linkedAccountId, tenantId)
			: await this.#resolveExternalAccount(input.email, provider, workspace);
		if (!account || account.status !== 'active')
			throw this.#invalidCredentials();
		if (
			!linkedAccountId &&
			(await this.#repository.findExternalIdentitySubject(
				provider,
				account.accountId,
				tenantId,
			)) !== null
		) {
			/* The account already answers to another subject at this provider. An
			   address the provider reports never re-binds it, which is what a
			   reused or transferred address would otherwise do. */
			throw this.#invalidCredentials();
		}
		await this.#repository.linkExternalIdentity({
			provider,
			subject,
			accountId: account.accountId,
			tenantId,
			now: this.#now(),
		});
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

	/* A binding already made resolves the membership it was made in. A platform
	   binding names no workspace and keeps resolving the account's own. */
	async #resolveLinkedAccount(
		accountId: string,
		tenantId: string | null,
	): Promise<AccountCredential | null> {
		if (!tenantId) {
			return this.#repository.findAccountCredentialById(accountId);
		}
		const membership = await this.#repository.findAccountMembership(
			accountId,
			tenantId,
		);
		return membership?.membershipStatus === 'active' ? membership : null;
	}

	/**
	 * The first sign-in through a provider, before any binding exists. The
	 * verified address only bootstraps the link: for a platform provider it
	 * resolves the account exactly as before, and for a workspace provider it
	 * resolves the membership of that workspace, provisioning one when the
	 * provider is configured to and the address is inside its domains.
	 */
	async #resolveExternalAccount(
		email: string,
		provider: string,
		workspace: TenantProviderSignIn | null,
	): Promise<AccountCredential | null> {
		const normalized = normalizeEmail(email);
		if (!workspace) return this.#repository.findAccountByEmail(normalized);
		const identity = await this.#repository.findAccountIdentity(normalized);
		if (identity && identity.status !== 'active') return null;
		if (identity) {
			const membership = await this.#repository.findAccountMembership(
				identity.accountId,
				workspace.tenantId,
			);
			if (membership) {
				return membership.membershipStatus === 'active' ? membership : null;
			}
		}
		return this.#provisionExternalMember(
			normalized,
			identity?.accountId ?? null,
			provider,
			workspace,
		);
	}

	/* Just-in-time provisioning. Every refusal happens before the first write,
	   so a provider that is not allowed to create members creates nothing. */
	async #provisionExternalMember(
		normalizedEmail: string,
		accountId: string | null,
		provider: string,
		workspace: TenantProviderSignIn,
	): Promise<AccountCredential | null> {
		if (!workspace.jitEnabled) return null;
		const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
		if (!domain || !workspace.allowedDomains.includes(domain)) return null;
		/* A tenant-owned provider may not absorb an account other workspaces
		   rely on. Reuse is limited to an account no workspace holds; anyone
		   else is invited by this workspace instead. */
		if (accountId && (await this.#repository.countMemberships(accountId)) > 0) {
			await this.#audit(
				workspace.tenantId,
				providerActor(provider),
				AUDIT_ACTIONS.jitRefused,
				'sign-in',
				provider,
				{ provider, reason: 'account-has-other-membership' },
			);
			throw new AuthServiceError(
				'JIT_ACCOUNT_EXISTS',
				'The account already belongs to another workspace.',
				401,
			);
		}
		const role = await this.#repository.findRoleByKey(
			workspace.tenantId,
			workspace.jitRole,
		);
		/* Saving a provider proves the role exists and deleting that role is
		   refused, so reaching this means the row and the roles drifted apart.
		   The refusal is recorded under its own reason rather than looking like
		   a domain or account refusal. */
		if (!role) {
			await this.#audit(
				workspace.tenantId,
				providerActor(provider),
				AUDIT_ACTIONS.jitRefused,
				'sign-in',
				provider,
				{ provider, reason: 'role-missing', role: workspace.jitRole },
			);
			return null;
		}
		const createdAt = this.#now();
		const member = accountId
			? await this.#repository.createMembershipInTenant({
					accountId,
					tenantId: workspace.tenantId,
					role: role.key,
					roleId: role.id,
					scopes: role.scopes,
					createdAt,
				})
			: await this.#repository.createAccountInTenant({
					accountId: randomUUID(),
					tenantId: workspace.tenantId,
					email: normalizedEmail,
					normalizedEmail,
					/* The account signs in through the provider. A random hash nobody
					   holds keeps the password path closed until a reset sets one. */
					passwordHash: await hashPassword(
						randomBytes(32).toString('base64url'),
						this.#passwordHash,
					),
					displayName: displayNameFromEmail(normalizedEmail),
					role: role.key,
					roleId: role.id,
					scopes: role.scopes,
					createdAt,
				});
		await this.#audit(
			workspace.tenantId,
			{ kind: 'user', id: member.accountId, label: member.email },
			AUDIT_ACTIONS.memberProvisioned,
			'account',
			member.accountId,
			{ provider, role: role.key },
		);
		return member;
	}

	/**
	 * The workspace's own status for one member. Disabling revokes that
	 * membership's sessions and API tokens and refuses its sign-in; the other
	 * workspaces of the same account are untouched, and the account status stays
	 * the deployment operator's platform-level block.
	 */
	async setMembershipStatus(
		actor: AuthActor,
		accountId: string,
		status: MembershipStatus,
	): Promise<{
		readonly accountId: string;
		readonly status: MembershipStatus;
	}> {
		const target = await this.#targetMember(actor, accountId, {
			allowSelf: false,
		});
		if (status === 'disabled') {
			await this.#assertOwnerRemains(
				actor.tenantId,
				target,
				target.status === 'active' && target.membershipStatus === 'active',
			);
		}
		await this.#repository.setMembershipStatus(
			target.accountId,
			actor.tenantId,
			status,
		);
		if (status === 'disabled') {
			await this.#repository.deleteMembershipSessions(
				target.accountId,
				actor.tenantId,
			);
			await this.#repository.revokeMembershipApiTokens(
				actor.tenantId,
				target.accountId,
				this.#now(),
				actor.accountId,
			);
		}
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			AUDIT_ACTIONS.membershipStatus,
			'account',
			target.accountId,
			{ status },
		);
		return { accountId: target.accountId, status };
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

	/**
	 * The one audit row a committed settings change owes. A flag is recorded
	 * under its own action with the values around the change, because an
	 * operator reviewing a flag needs to see what it was turned to; every other
	 * setting keeps the plain record, so no declared value ever reaches the
	 * trail by the side door.
	 */
	async recordSettingsUpdate(
		actor: AuthActor,
		change: ModuleSettingChange,
	): Promise<void> {
		const flag = change.kind === 'flag';
		await this.#audit(
			actor.tenantId,
			this.#actorOf(actor),
			flag ? AUDIT_ACTIONS.settingsFlagChanged : AUDIT_ACTIONS.settingsUpdated,
			'setting',
			`${change.moduleId}.${change.key}`,
			flag
				? {
						cleared: change.cleared,
						previous: change.previous,
						next: change.next,
					}
				: { cleared: change.cleared },
		);
	}

	async queryAudit(query: AuditQuery): Promise<AuditActorPage> {
		const limit = Math.min(
			Math.max(1, Math.trunc(query.limit)),
			MAX_AUDIT_PAGE,
		);
		const from = this.#auditBound(query.from, 'from');
		const to = this.#auditBound(query.to, 'to');
		/* A window that ends before it starts would answer an empty page, which a
		   caller cannot tell from a workspace with no events in the window. */
		if (from !== null && to !== null && from > to) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				'from must not be later than to.',
				400,
			);
		}
		const events = await this.#repository.queryAudit({
			...query,
			tenantId: this.#identifier(query.tenantId, 'tenantId'),
			from,
			to,
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
		/* A membership the workspace disabled is not a workspace this account may
		   enter, and it answers exactly as one it never held. */
		if (!account || account.membershipStatus !== 'active') {
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
		if (
			!membership ||
			membership.status !== 'active' ||
			membership.membershipStatus !== 'active'
		) {
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
		if (
			!membership ||
			membership.status !== 'active' ||
			membership.membershipStatus !== 'active'
		)
			return null;
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

	/* One end of the audit window. An absent end is open; a bound that is not an
	   epoch millisecond is a caller defect rather than an open end, because
	   silently dropping it would answer a wider trail than was asked for. */
	#auditBound(value: number | null | undefined, field: string): number | null {
		if (value === null || value === undefined) return null;
		if (!Number.isSafeInteger(value)) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`${field} must be an epoch millisecond timestamp.`,
				400,
			);
		}
		return value;
	}

	/* The bound a paged read surface carries into SQL, so no caller of one can
	   ask a workspace of unknown size for all of it. */
	#pageLimit(limit: number, max: number): number {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
			throw new AuthServiceError(
				'INVALID_INPUT',
				`Limit must be 1 to ${max}.`,
				400,
			);
		}
		return limit;
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
