import { validateApplicationPath } from '@flowdular/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Middleware } from '@octanejs/app-core';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import {
	createModuleSettingsRuntime as createKernelSettingsRuntime,
	normalizeActor,
	parsePreviousKeys,
	PLATFORM_SETTINGS_TENANT,
	type Actor,
	type ModuleSettingsRuntime,
	type PlatformDataClassRegistry,
} from '@flowdular/kernel';
import {
	createSecurityHeadersMiddleware,
	mailConfigFromEnvironment,
	DEVELOPMENT_CONTENT_SECURITY_POLICY,
	PRODUCTION_CONTENT_SECURITY_POLICY,
	type MailPort,
} from '@flowdular/server';
import { createAuthenticationMiddleware } from '../middleware/authentication.ts';
import { AuthService, type AuthPolicy } from '../services/auth-service.ts';
import { authDataClasses } from '../services/data-classes.ts';
import {
	DatabaseAuthRepository,
	migrateAuthDatabase,
} from '../services/database-repository.ts';
import {
	DevelopmentMailDelivery,
	type AuthMailDelivery,
} from '../services/mail-delivery.ts';
import { createMailPortDelivery } from '../services/mail-port.ts';
import { SmtpMailDelivery } from '../services/mail-smtp.ts';
import type { AuthRepository } from '../services/repository.ts';
import { createSessionSweepRunner } from '../services/session-sweep-runner.ts';
import {
	createAuthSettingsStore,
	type AuthSettingsStore,
} from '../services/settings-store.ts';
import type { AuthCookieConfig } from '../api/cookies.ts';
import {
	createAuthModuleSettings,
	DEFAULT_PASSWORD_MIN_LENGTH,
	DEFAULT_SESSION_IDLE_MINUTES,
	DEFAULT_SESSION_TTL_HOURS,
	parseProviderList,
	type AuthSettings,
	type AuthTenantSettings,
} from '../settings.ts';
import {
	createMfaEnrolmentMiddleware,
	guardMfaSettings,
} from './mfa-enforcement.ts';
import {
	createOidcVerifier,
	discoverOidcProvider,
	type OidcVerifier,
} from './oidc.ts';
import { providerHostAllowlist } from './provider-host.ts';

export interface AuthRuntimeOptions extends AuthRuntimeEnvironmentOptions {
	/** Platform-owned provider. auth.core never receives a DSN or a pool. */
	readonly databases: DatabaseProvider;
	/** Tenant-scoped lease purpose; `migration` is taken and released internally. */
	readonly purpose?: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/**
	 * The platform registry this module declares into. auth.core composes ahead
	 * of the module composition, so it receives the registry here rather than
	 * through a module server context. Absent, nothing is declared and the
	 * workspace sees auth.core holding no class.
	 */
	readonly dataClasses?: PlatformDataClassRegistry;
	/**
	 * The platform mail port. When it is composed and configured it is the
	 * transport, ahead of anything this module derived from the environment:
	 * both read the same variables, and one deployment has one outbox.
	 */
	readonly mail?: MailPort;
}

/** Everything the process environment can decide on its own. */
export interface AuthRuntimeEnvironmentOptions {
	readonly secureCookies: boolean;
	/* Applications that share a host with the platform must not share its
	   session cookie; cookies ignore the port. */
	readonly cookieName?: string;
	/* The remaining values are deployment defaults for the declared auth.core
	   settings; a value stored through the Settings screen wins at read time. */
	readonly sessionTtlMs: number;
	readonly sessionIdleMs?: number;
	readonly passwordMinLength?: number;
	readonly allowSignUp: boolean;
	readonly emailConfirmation: boolean;
	readonly signInProviders: readonly string[];
	/** Locales a tenant may pick as default; from flowdular.json when known. */
	readonly locales?: readonly string[];
	readonly workspaceRoot?: string;
	/** Honor x-forwarded-for; only behind a reverse proxy that sets it. */
	readonly trustProxy?: boolean;
	/** True once a mail transport is composed; gates email confirmation. */
	readonly mailTransport?: boolean;
	readonly mailDelivery?: AuthMailDelivery;
	readonly mfaEncryptionKey?: string;
	/** Retired keys that still open stored factors; nothing is written with them. */
	readonly mfaPreviousEncryptionKeys?: readonly string[];
	readonly publicBaseUrl?: string;
	readonly applicationPath?: string;
	readonly oidcProviders?: readonly OidcProvider[];
	/** Hosts a provider URL may name; empty allows every public host. */
	readonly providerHosts?: readonly string[];
	readonly production?: boolean;
	readonly contentSecurityPolicy?: string | null;
	readonly contentSecurityPolicyReportOnly?: boolean;
	/** Share an existing settings runtime instead of opening one of its own. */
	readonly settings?: ModuleSettingsRuntime;
}

export interface OidcProvider {
	readonly id: string;
	/** Exact `iss` value; discovery and every ID token are bound to it. */
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint: string;
	readonly clientId: string;
	readonly clientSecret: string;
}

export interface AuthRuntime {
	readonly cookie: AuthCookieConfig;
	readonly middleware: Middleware;
	/** Live view of the declared auth.core settings. */
	readonly settings: AuthSettings;
	readonly moduleSettings: ModuleSettingsRuntime;
	/** Verifies provider ID tokens; its key cache lives with this runtime. */
	readonly oidcVerifier: OidcVerifier;
	readonly trustProxy: boolean;
	readonly mailTransport: boolean;
	/** True once a deployment MFA key is composed; gates requireMfa. */
	readonly mfaKeyConfigured: boolean;
	readonly workspaceRoot: string | null;
	readonly oidcProviders: readonly OidcProvider[];
	/**
	 * FD_AUTH_PROVIDER_HOST_ALLOWLIST. Every provider URL this runtime fetches,
	 * a workspace's discovery request and the stored token and userinfo
	 * endpoints alike, has to name one of these hosts; empty allows any public
	 * host and still refuses loopback names and literal addresses.
	 */
	readonly providerHosts: readonly string[];
	readonly publicBaseUrl: string | null;
	readonly applicationPath?: string;
	/* Resolves once the schema is migrated and the leases are held. Concurrent
	   first callers await the same initialization. */
	service(): Promise<AuthService>;
	/**
	 * Tenant-scoped auth.core settings of one workspace. The stored values are
	 * loaded once per workspace before the first answer, so a security decision
	 * never observes the declared default in place of a stored value.
	 */
	tenantSettings(tenantId: string): Promise<AuthTenantSettings>;
	/* Re-read at the point of use. A stored run snapshot is only a ceiling and
	   never substitutes for the actor's current membership. */
	authorizeAgentToolAccess(
		tenantId: string,
		actor: Actor,
	): Promise<readonly string[]>;
	/**
	 * Resolves once every settings audit row accepted so far has been written.
	 * The kernel change listener is synchronous, so the write is started after
	 * it returns; a caller that must observe the trail waits on this first.
	 */
	settingsAuditSettled(): Promise<void>;
	/** Terminal, idempotent release used by platform HMR and process shutdown. */
	dispose(): Promise<void>;
}

function booleanEnvironment(
	value: string | undefined,
	fallback: boolean,
	name: string,
): boolean {
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${name} must be true or false.`);
}

function integerEnvironment(
	value: string | undefined,
	fallback: number,
	name: string,
	min: number,
	max: number,
): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}.`);
	}
	return parsed;
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

function providersEnvironment(
	value: string | undefined,
	name: string,
): readonly string[] {
	if (value === undefined || value.trim() === '') return [];
	const providers = parseProviderList(value);
	for (const provider of providers) {
		if (!PROVIDER_PATTERN.test(provider)) {
			throw new Error(`${name} contains an invalid provider id: ${provider}`);
		}
	}
	return providers;
}

function oidcProvidersEnvironment(
	value: string | undefined,
): readonly OidcProvider[] {
	if (!value?.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('FD_AUTH_OIDC_PROVIDERS must be valid JSON.');
	}
	if (!Array.isArray(parsed) || parsed.length > 8)
		throw new Error(
			'FD_AUTH_OIDC_PROVIDERS must be an array of at most eight providers.',
		);
	return parsed.map((entry): OidcProvider => {
		if (!entry || typeof entry !== 'object')
			throw new Error('OIDC provider configuration is invalid.');
		const source = entry as Record<string, unknown>;
		const text = (key: string): string => {
			const value = source[key];
			if (typeof value !== 'string' || value.trim().length === 0)
				throw new Error('OIDC provider configuration is incomplete.');
			return value.trim();
		};
		const id = text('id').toLowerCase();
		if (!PROVIDER_PATTERN.test(id))
			throw new Error('OIDC provider id is invalid.');
		/* Required: the ID token is verified against this exact issuer, and the
		   key set is discovered under it. A provider without one cannot be
		   verified, so it is refused at boot rather than trusted at sign-in. */
		const issuer = text('issuer');
		const authorizationEndpoint = text('authorizationEndpoint');
		const tokenEndpoint = text('tokenEndpoint');
		const userInfoEndpoint = text('userInfoEndpoint');
		for (const value of [
			issuer,
			authorizationEndpoint,
			tokenEndpoint,
			userInfoEndpoint,
		]) {
			try {
				if (new URL(value).protocol !== 'https:') throw new Error();
			} catch {
				throw new Error('OIDC endpoints must use valid HTTPS URLs.');
			}
		}
		return {
			id,
			issuer,
			authorizationEndpoint,
			tokenEndpoint,
			userInfoEndpoint,
			clientId: text('clientId'),
			clientSecret: text('clientSecret'),
		};
	});
}

function assertMfaEncryptionKey(value: string, label: string): void {
	const hex = /^[0-9a-f]{64}$/i.test(value);
	const base64url = /^[A-Za-z0-9_-]{43}=?$/.test(value);
	const bytes = Buffer.from(value, hex ? 'hex' : 'base64url');
	if ((!hex && !base64url) || bytes.byteLength !== 32) {
		throw new Error(`${label} must encode exactly 32 bytes.`);
	}
}

function publicOriginEnvironment(
	value: string | undefined,
): string | undefined {
	if (!value?.trim()) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('FD_AUTH_PUBLIC_ORIGIN must be an absolute URL.');
	}
	if (url.username || url.password) {
		throw new Error('FD_AUTH_PUBLIC_ORIGIN must not contain URL credentials.');
	}
	if (url.pathname !== '/' || url.search || url.hash) {
		throw new Error('FD_AUTH_PUBLIC_ORIGIN must contain only an origin.');
	}
	const loopback =
		url.hostname === 'localhost' ||
		url.hostname === '::1' ||
		url.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new Error(
			'FD_AUTH_PUBLIC_ORIGIN must use HTTPS unless it is a loopback origin.',
		);
	}
	return url.origin;
}

/* The transport is chosen here so a deployment that composes auth.core without
   the platform, the sandbox preview runtime above all, still configures mail
   with environment variables. The variables, their retired auth.core names and
   every refusal come from the platform reader, so both paths answer the same
   environment the same way. */
function mailDeliveryFromEnvironment(
	environment: NodeJS.ProcessEnv,
): AuthMailDelivery | undefined {
	const config = mailConfigFromEnvironment(environment);
	if (config.adapter === 'none') return undefined;
	if (config.adapter === 'development') return new DevelopmentMailDelivery();
	return new SmtpMailDelivery({
		url: config.smtp.url,
		from: config.from,
		rejectUnauthorized: config.smtp.rejectUnauthorized,
		requireTLS: config.smtp.requireTLS,
		variables: { url: config.variables.url, from: config.variables.from },
	});
}

/* The tenant default locale is validated against the workspace locales; a
   missing or unreadable flowdular.json falls back to the module's own list. */
function workspaceLocales(
	workspaceRoot: string,
): readonly string[] | undefined {
	try {
		const config = JSON.parse(
			readFileSync(resolve(workspaceRoot, 'flowdular.json'), 'utf8'),
		) as { locales?: unknown };
		return Array.isArray(config.locales) &&
			config.locales.every((entry) => typeof entry === 'string')
			? (config.locales as string[])
			: undefined;
	} catch {
		return undefined;
	}
}

/* The database is not one of them: composition owns the provider and passes it
   to createAuthRuntime alongside this result. */
export function authRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): AuthRuntimeEnvironmentOptions {
	const production = environment.NODE_ENV === 'production';
	const mailDelivery = mailDeliveryFromEnvironment(environment);
	const mailTransport = mailDelivery !== undefined;
	const emailConfirmation = booleanEnvironment(
		environment.FD_AUTH_EMAIL_CONFIRMATION,
		false,
		'FD_AUTH_EMAIL_CONFIRMATION',
	);
	if (emailConfirmation && !mailTransport) {
		throw new Error(
			'FD_AUTH_EMAIL_CONFIRMATION requires a composed mail transport; none is available.',
		);
	}
	if (environment.FD_AUTH_MFA_KEY) {
		assertMfaEncryptionKey(environment.FD_AUTH_MFA_KEY, 'FD_AUTH_MFA_KEY');
	}
	const mfaPreviousEncryptionKeys = parsePreviousKeys(
		environment.FD_AUTH_MFA_KEY_PREVIOUS,
		(entry) => {
			assertMfaEncryptionKey(entry, 'Every FD_AUTH_MFA_KEY_PREVIOUS entry');
			return entry;
		},
	);
	const publicBaseUrl = publicOriginEnvironment(
		environment.FD_AUTH_PUBLIC_ORIGIN,
	);
	const locales = workspaceLocales(workspaceRoot);
	return {
		secureCookies: booleanEnvironment(
			environment.FD_AUTH_SECURE_COOKIE,
			production,
			'FD_AUTH_SECURE_COOKIE',
		),
		sessionTtlMs:
			integerEnvironment(
				environment.FD_AUTH_SESSION_TTL_HOURS,
				DEFAULT_SESSION_TTL_HOURS,
				'FD_AUTH_SESSION_TTL_HOURS',
				1,
				168,
			) *
			60 *
			60 *
			1000,
		sessionIdleMs:
			integerEnvironment(
				environment.FD_AUTH_SESSION_IDLE_MINUTES,
				DEFAULT_SESSION_IDLE_MINUTES,
				'FD_AUTH_SESSION_IDLE_MINUTES',
				5,
				1440,
			) *
			60 *
			1000,
		passwordMinLength: integerEnvironment(
			environment.FD_AUTH_PASSWORD_MIN_LENGTH,
			DEFAULT_PASSWORD_MIN_LENGTH,
			'FD_AUTH_PASSWORD_MIN_LENGTH',
			8,
			128,
		),
		// Public registration stays opt-in for production deployments.
		allowSignUp: booleanEnvironment(
			environment.FD_AUTH_ALLOW_SIGN_UP,
			!production,
			'FD_AUTH_ALLOW_SIGN_UP',
		),
		emailConfirmation,
		signInProviders: providersEnvironment(
			environment.FD_AUTH_SIGN_IN_PROVIDERS,
			'FD_AUTH_SIGN_IN_PROVIDERS',
		),
		oidcProviders: oidcProvidersEnvironment(environment.FD_AUTH_OIDC_PROVIDERS),
		providerHosts: providerHostAllowlist(
			environment.FD_AUTH_PROVIDER_HOST_ALLOWLIST,
		),
		...(locales ? { locales } : {}),
		workspaceRoot,
		trustProxy: booleanEnvironment(
			environment.FD_TRUST_PROXY,
			false,
			'FD_TRUST_PROXY',
		),
		mailTransport,
		...(mailDelivery ? { mailDelivery } : {}),
		...(environment.FD_AUTH_MFA_KEY
			? { mfaEncryptionKey: environment.FD_AUTH_MFA_KEY }
			: {}),
		...(mfaPreviousEncryptionKeys.length > 0
			? { mfaPreviousEncryptionKeys }
			: {}),
		...(publicBaseUrl ? { publicBaseUrl } : {}),
		production,
		contentSecurityPolicy:
			environment.FD_CSP?.trim() ||
			(production
				? PRODUCTION_CONTENT_SECURITY_POLICY
				: DEVELOPMENT_CONTENT_SECURITY_POLICY),
		contentSecurityPolicyReportOnly: booleanEnvironment(
			environment.FD_CSP_REPORT_ONLY,
			!production,
			'FD_CSP_REPORT_ONLY',
		),
	};
}

function cookieName(options: AuthRuntimeOptions): string {
	const configured = options.cookieName?.trim();
	if (!configured) {
		return options.secureCookies
			? '__Host-coreloom_session'
			: 'coreloom_session_dev';
	}
	if (!/^[A-Za-z0-9_-]{4,64}$/.test(configured)) {
		throw new Error('Session cookie name contains unsupported characters.');
	}
	if (options.secureCookies && !configured.startsWith('__Host-')) {
		throw new Error(
			'A secure session cookie name must use the __Host- prefix.',
		);
	}
	return configured;
}

const EXPIRED_SESSION_SWEEP_MS = 15 * 60 * 1000;
/* Bound on remembered per-workspace settings primes; least recently added is
   evicted, and an evicted workspace is primed again on its next request. */
const PRIMED_TENANT_LIMIT = 1024;

const RUNTIME_REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
} as const;

const MIGRATION_REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
		DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
		DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
	],
} as const;

interface OpenedAuthDatabase {
	readonly repository: AuthRepository;
	readonly leases: readonly DatabaseAdapterLease[];
}

/* The schema is owned by the migration role and released before any request
   can run: the tenant-scoped runtime role never holds DDL rights. The
   background lease is the read-only role that answers which workspace owns a
   session token, a bearer token, an invitation or an email address. */
async function openAuthDatabase(
	databases: DatabaseProvider,
	purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>,
): Promise<OpenedAuthDatabase> {
	const migration = await databases.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
		requirements: MIGRATION_REQUIREMENTS,
	});
	try {
		await migrateAuthDatabase(migration.database);
	} finally {
		await migration.release();
	}
	const runtime = await databases.acquire({
		namespace: 'auth.core',
		purpose,
		requirements: RUNTIME_REQUIREMENTS,
	});
	try {
		const background = await databases.acquire({
			namespace: 'auth.core',
			purpose: 'background',
			requirements: RUNTIME_REQUIREMENTS,
		});
		return {
			repository: new DatabaseAuthRepository({
				runtime: runtime.database,
				background: background.database,
			}),
			leases: [runtime, background],
		};
	} catch (error) {
		/* A deployment that declares no cross-tenant role is refused here. The
		   lease already taken goes back before the error leaves. */
		await runtime.release();
		throw error;
	}
}

export interface AuthModuleSettingsRuntime {
	readonly settings: ModuleSettingsRuntime;
	/** Resolves once every pending settings read and write has landed. */
	ready(): Promise<void>;
	dispose(): Promise<void>;
}

/* Standalone settings runtime over the auth.core namespace, for a composition
   root or a CLI that needs settings without the rest of the auth runtime. */
export function createModuleSettingsRuntime(options: {
	readonly databases: DatabaseProvider;
	readonly purpose?: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}): AuthModuleSettingsRuntime {
	let opened: Promise<OpenedAuthDatabase> | undefined;
	const open = () =>
		(opened ??= openAuthDatabase(
			options.databases,
			options.purpose ?? 'runtime',
		));
	const store = createAuthSettingsStore(async () => (await open()).repository);
	return {
		settings: createKernelSettingsRuntime(store),
		ready: () => store.ready(),
		async dispose() {
			const pending = opened;
			opened = undefined;
			if (!pending) return;
			await store.ready().catch(() => undefined);
			const database = await pending.catch(() => undefined);
			for (const lease of database?.leases ?? []) await lease.release();
		},
	};
}

export function createAuthRuntime(options: AuthRuntimeOptions): AuthRuntime {
	if (options.mfaEncryptionKey) {
		assertMfaEncryptionKey(options.mfaEncryptionKey, 'The MFA encryption key');
	}
	for (const key of options.mfaPreviousEncryptionKeys ?? []) {
		assertMfaEncryptionKey(key, 'Every previous MFA encryption key');
	}
	let opened: Promise<OpenedAuthDatabase> | undefined;
	let servicePromise: Promise<AuthService> | undefined;
	let disposed = false;
	const open = (): Promise<OpenedAuthDatabase> => {
		if (disposed) throw new Error('Auth runtime is disposed.');
		return (opened ??= openAuthDatabase(
			options.databases,
			options.purpose ?? 'runtime',
		));
	};
	const repository = async (): Promise<AuthRepository> =>
		(await open()).repository;
	const store: AuthSettingsStore = createAuthSettingsStore(repository);
	/* Declared while the platform composes, because the registry is sealed
	   before any start hook runs. auth.core names itself rather than relying on
	   a binding: the same runtime composes in processes that hand it an unbound
	   registry. */
	options.dataClasses?.declare('auth.core', authDataClasses(repository));
	const mailDelivery = options.mail?.configured
		? createMailPortDelivery(options.mail)
		: options.mailDelivery;
	/* A composed delivery is a transport whatever the flag says; the flag alone
	   still answers for a caller that composes none. */
	const mailTransport =
		mailDelivery !== undefined || (options.mailTransport ?? false);
	const mfaKeyConfigured = options.mfaEncryptionKey !== undefined;
	/* The settings runtime auth hands to the platform is where a workspace turns
	   requireMfa on, so it is where a keyless deployment has to be refused. */
	const moduleSettings = guardMfaSettings(
		options.settings ?? createKernelSettingsRuntime(store),
		mfaKeyConfigured,
	);
	moduleSettings.declare(
		createAuthModuleSettings({
			allowSignUp: options.allowSignUp,
			emailConfirmation: options.emailConfirmation,
			sessionTtlHours: Math.max(
				1,
				Math.round(options.sessionTtlMs / 3_600_000),
			),
			sessionIdleMinutes: Math.max(
				5,
				Math.round(
					(options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MINUTES * 60_000) /
						60_000,
				),
			),
			passwordMinLength:
				options.passwordMinLength ?? DEFAULT_PASSWORD_MIN_LENGTH,
			signInProviders: options.signInProviders,
			...(options.locales ? { locales: options.locales } : {}),
		}),
	);
	const read = <T extends string | number | boolean>(key: string): T =>
		moduleSettings.get<T>(PLATFORM_SETTINGS_TENANT, 'auth.core', key);
	const settings: AuthSettings = {
		get allowSignUp() {
			return read<boolean>('allowSignUp');
		},
		get emailConfirmation() {
			return mailTransport && read<boolean>('emailConfirmation');
		},
		get signInProviders() {
			return parseProviderList(read<string>('signInProviders'));
		},
		get sessionTtlMs() {
			return read<number>('sessionTtlHours') * 60 * 60 * 1000;
		},
		get sessionIdleMs() {
			return read<number>('sessionIdleMinutes') * 60 * 1000;
		},
		get passwordMinLength() {
			return read<number>('passwordMinLength');
		},
	};
	/* A workspace snapshot is filled asynchronously, so the first read for a
	   workspace would otherwise see the declared default in place of a stored
	   value. Priming is awaited once per workspace and remembered; a failed
	   prime drops out of the map so the next request retries instead of
	   answering from an empty snapshot forever. Evicting an entry only costs a
	   repeat prime over a snapshot the store already holds. */
	const primed = new Map<string, Promise<void>>();
	const primeTenant = (tenantId: string): Promise<void> => {
		const existing = primed.get(tenantId);
		if (existing) return existing;
		const pending = store
			.prime(tenantId, 'auth.core')
			.catch((error: unknown) => {
				primed.delete(tenantId);
				throw error;
			});
		if (primed.size >= PRIMED_TENANT_LIMIT) {
			const oldest = primed.keys().next().value;
			if (oldest !== undefined) primed.delete(oldest);
		}
		primed.set(tenantId, pending);
		return pending;
	};
	const tenantSettings = async (
		tenantId: string,
	): Promise<AuthTenantSettings> => {
		await primeTenant(tenantId);
		return {
			requireMfa: moduleSettings.get<boolean>(
				tenantId,
				'auth.core',
				'requireMfa',
			),
		};
	};
	const policy = (): AuthPolicy => ({
		sessionTtlMs: settings.sessionTtlMs,
		sessionIdleMs: settings.sessionIdleMs,
		passwordMinLength: settings.passwordMinLength,
	});
	const cookie: AuthCookieConfig = {
		name: cookieName(options),
		secure: options.secureCookies,
		get maxAgeSeconds() {
			return Math.floor(settings.sessionTtlMs / 1000);
		},
	};
	/* The verifier this runtime serves with. The service invalidates its cached
	   key sets when a workspace changes or deletes a provider row. */
	const oidcVerifier = createOidcVerifier();
	const providerHosts = options.providerHosts ?? [];
	const create = async (): Promise<AuthService> => {
		const { repository } = await open();
		/* The settings this runtime reads on every request are platform scoped.
		   Priming them here means a request never observes the declared default
		   in place of a stored value. */
		await store.prime(PLATFORM_SETTINGS_TENANT, 'auth.core');
		const authService = new AuthService(repository, {
			policy,
			/* Saving a workspace provider verifies its issuer the same way every
			   ID token is verified against it: discovery under the issuer, naming
			   the issuer back. */
			oidcDiscovery: (issuer) => discoverOidcProvider(issuer, providerHosts),
			forgetProviderKeys: (providerId) => oidcVerifier.forget(providerId),
			...(options.mfaEncryptionKey
				? { mfaEncryptionKey: options.mfaEncryptionKey }
				: {}),
			...(options.mfaPreviousEncryptionKeys
				? { mfaPreviousEncryptionKeys: options.mfaPreviousEncryptionKeys }
				: {}),
			...(mailDelivery ? { mailDelivery } : {}),
			...(options.publicBaseUrl
				? { publicBaseUrl: options.publicBaseUrl }
				: {}),
		});
		// Expired rows only matter for storage; the lookup already filters them.
		sessionSweep.start();
		return authService;
	};
	const service = (): Promise<AuthService> => {
		if (disposed) {
			return Promise.reject(new Error('Auth runtime is disposed.'));
		}
		return (servicePromise ??= create());
	};
	/* The platform runner owns the loop: its interval and unref, the guard
	   against overlapping passes and the drain on dispose. It starts with the
	   service it sweeps through, so a runtime nobody uses opens no database. */
	const sessionSweep = createSessionSweepRunner({
		sweep: service,
		intervalMs: EXPIRED_SESSION_SWEEP_MS,
	});
	/* Settings writes are audited at the store owner, so the settings
	   administration API in system.core needs no audit dependency. The kernel
	   change listener is synchronous, so the audit row is written after it
	   returns and a failure is reported instead of failing the setting. */
	/* An accepted settings change owes an audit row. Tracking the in-flight
	   writes is what lets disposal drain them instead of dropping them. */
	const settingsAuditWrites = new Set<Promise<void>>();
	const detachSettingsAudit = moduleSettings.onChange((change) => {
		const write = (async () => {
			const { repository } = await open();
			const membership = await repository.findAccountMembership(
				change.actor.accountId,
				change.actor.tenantId,
			);
			await (
				await service()
			).recordSettingsUpdate(
				{
					accountId: change.actor.accountId,
					tenantId: change.actor.tenantId,
					email: membership?.email ?? change.actor.accountId,
					role: membership?.role ?? '',
					scopes: membership?.scopes ?? [],
				},
				change,
			);
		})().catch((error: unknown) => {
			console.error(
				`[auth.core] settings audit write failed for ${change.moduleId}.${change.key}:`,
				error instanceof Error ? error.message : error,
			);
		});
		settingsAuditWrites.add(write);
		void write.finally(() => settingsAuditWrites.delete(write));
	});
	const securityHeaders = createSecurityHeadersMiddleware({
		strictTransportSecurity: options.secureCookies,
		contentSecurityPolicy:
			options.contentSecurityPolicy === undefined
				? options.production
					? PRODUCTION_CONTENT_SECURITY_POLICY
					: DEVELOPMENT_CONTENT_SECURITY_POLICY
				: options.contentSecurityPolicy,
		reportOnly: options.contentSecurityPolicyReportOnly ?? !options.production,
	});
	const authentication = createAuthenticationMiddleware(service, cookie);
	const mfaEnrolment = createMfaEnrolmentMiddleware({
		tenantSettings,
		service,
	});
	return {
		cookie,
		settings,
		moduleSettings,
		oidcVerifier,
		tenantSettings,
		trustProxy: options.trustProxy ?? false,
		mailTransport,
		mfaKeyConfigured,
		workspaceRoot: options.workspaceRoot ?? null,
		oidcProviders: options.oidcProviders ?? [],
		providerHosts,
		publicBaseUrl: options.publicBaseUrl ?? null,
		applicationPath: validateApplicationPath(options.applicationPath ?? '/app'),
		service,
		async authorizeAgentToolAccess(tenantId, actor) {
			const identity = normalizeActor(actor);
			if (!identity || identity.kind !== 'user') return [];
			const membership = await (
				await open()
			).repository.findAccountMembership(identity.id, tenantId);
			return membership?.status === 'active' &&
				membership.membershipStatus === 'active'
				? [...new Set(membership.scopes)].sort()
				: [];
		},
		async settingsAuditSettled() {
			await Promise.allSettled([...settingsAuditWrites]);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			detachSettingsAudit();
			await Promise.allSettled([...settingsAuditWrites]);
			/* A sweep in flight holds the lease it deletes under, so the loop is
			   drained before anything is released. */
			await sessionSweep.dispose();
			const database = opened;
			opened = undefined;
			servicePromise = undefined;
			if (!database) return;
			/* A settings write accepted before disposal still has to land, and its
			   lease has to outlive it. */
			await store.ready().catch(() => undefined);
			for (const lease of (await database).leases) await lease.release();
		},
		/* Enrolment runs inside authentication: it needs the resolved principal,
		   and it must cover every route an endpoint identity resolver covers. */
		middleware: (context, next) =>
			securityHeaders(context, () =>
				Promise.resolve(
					authentication(context, () =>
						Promise.resolve(mfaEnrolment(context, next)),
					),
				),
			),
	};
}
