import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Middleware } from '@octanejs/app-core';
import {
	createModuleSettingsRuntime as createKernelSettingsRuntime,
	normalizeActor,
	PLATFORM_SETTINGS_TENANT,
	type Actor,
	type ModuleSettingsRuntime,
} from '@coreloom/kernel';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import {
	createSecurityHeadersMiddleware,
	DEVELOPMENT_CONTENT_SECURITY_POLICY,
	PRODUCTION_CONTENT_SECURITY_POLICY,
} from '@coreloom/server';
import { createAuthenticationMiddleware } from '../middleware/authentication.ts';
import { AuthService, type AuthPolicy } from '../services/auth-service.ts';
import {
	DevelopmentMailDelivery,
	type AuthMailDelivery,
} from '../services/mail-delivery.ts';
import { SqliteAuthRepository } from '../services/sqlite-repository.ts';
import type { AuthCookieConfig } from '../api/cookies.ts';
import {
	createAuthModuleSettings,
	DEFAULT_PASSWORD_MIN_LENGTH,
	DEFAULT_SESSION_IDLE_MINUTES,
	DEFAULT_SESSION_TTL_HOURS,
	parseProviderList,
	type AuthSettings,
} from '../settings.ts';

export interface AuthRuntimeOptions {
	readonly databasePath: string;
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
	/** Locales a tenant may pick as default; from coreloom.json when known. */
	readonly locales?: readonly string[];
	readonly workspaceRoot?: string;
	/** Honor x-forwarded-for; only behind a reverse proxy that sets it. */
	readonly trustProxy?: boolean;
	/** True once a mail transport is composed; gates email confirmation. */
	readonly mailTransport?: boolean;
	readonly mailDelivery?: AuthMailDelivery;
	readonly mfaEncryptionKey?: string;
	readonly publicBaseUrl?: string;
	readonly oidcProviders?: readonly OidcProvider[];
	readonly production?: boolean;
	readonly contentSecurityPolicy?: string | null;
	readonly contentSecurityPolicyReportOnly?: boolean;
	/** Share an existing settings runtime instead of opening one on auth.db. */
	readonly settings?: ModuleSettingsRuntime;
}

export interface OidcProvider {
	readonly id: string;
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
	readonly trustProxy: boolean;
	readonly mailTransport: boolean;
	readonly workspaceRoot: string | null;
	readonly oidcProviders: readonly OidcProvider[];
	readonly publicBaseUrl: string | null;
	service(): AuthService;
	/* Re-read at the point of use. A stored run snapshot is only a ceiling and
	   never substitutes for the actor's current membership. */
	authorizeAgentToolAccess(tenantId: string, actor: Actor): readonly string[];
	/** Terminal, idempotent release used by platform HMR and process shutdown. */
	dispose(): void;
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
		throw new Error('CL_AUTH_OIDC_PROVIDERS must be valid JSON.');
	}
	if (!Array.isArray(parsed) || parsed.length > 8)
		throw new Error(
			'CL_AUTH_OIDC_PROVIDERS must be an array of at most eight providers.',
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
		const authorizationEndpoint = text('authorizationEndpoint');
		const tokenEndpoint = text('tokenEndpoint');
		const userInfoEndpoint = text('userInfoEndpoint');
		for (const value of [
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
		throw new Error('CL_AUTH_PUBLIC_ORIGIN must be an absolute URL.');
	}
	if (url.username || url.password) {
		throw new Error('CL_AUTH_PUBLIC_ORIGIN must not contain URL credentials.');
	}
	if (url.pathname !== '/' || url.search || url.hash) {
		throw new Error('CL_AUTH_PUBLIC_ORIGIN must contain only an origin.');
	}
	const loopback =
		url.hostname === 'localhost' ||
		url.hostname === '::1' ||
		url.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new Error(
			'CL_AUTH_PUBLIC_ORIGIN must use HTTPS unless it is a loopback origin.',
		);
	}
	return url.origin;
}

/* The tenant default locale is validated against the workspace locales; a
   missing or unreadable coreloom.json falls back to the module's own list. */
function workspaceLocales(
	workspaceRoot: string,
): readonly string[] | undefined {
	try {
		const config = JSON.parse(
			readFileSync(resolve(workspaceRoot, 'coreloom.json'), 'utf8'),
		) as { locales?: unknown };
		return Array.isArray(config.locales) &&
			config.locales.every((entry) => typeof entry === 'string')
			? (config.locales as string[])
			: undefined;
	} catch {
		return undefined;
	}
}

export function authRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): AuthRuntimeOptions {
	const production = environment.NODE_ENV === 'production';
	const developmentMail = booleanEnvironment(
		environment.CL_AUTH_DEVELOPMENT_MAIL,
		false,
		'CL_AUTH_DEVELOPMENT_MAIL',
	);
	if (developmentMail && production) {
		throw new Error(
			'CL_AUTH_DEVELOPMENT_MAIL is only allowed outside production.',
		);
	}
	const mailDelivery = developmentMail
		? new DevelopmentMailDelivery()
		: undefined;
	const mailTransport = mailDelivery !== undefined;
	const emailConfirmation = booleanEnvironment(
		environment.CL_AUTH_EMAIL_CONFIRMATION,
		false,
		'CL_AUTH_EMAIL_CONFIRMATION',
	);
	if (emailConfirmation && !mailTransport) {
		throw new Error(
			'CL_AUTH_EMAIL_CONFIRMATION requires a composed mail transport; none is available.',
		);
	}
	if (environment.CL_AUTH_MFA_KEY) {
		assertMfaEncryptionKey(environment.CL_AUTH_MFA_KEY, 'CL_AUTH_MFA_KEY');
	}
	const publicBaseUrl = publicOriginEnvironment(
		environment.CL_AUTH_PUBLIC_ORIGIN,
	);
	const locales = workspaceLocales(workspaceRoot);
	return {
		databasePath:
			environment.CL_AUTH_DATABASE ??
			(production
				? '/data/auth.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'auth.db')),
		secureCookies: booleanEnvironment(
			environment.CL_AUTH_SECURE_COOKIE,
			production,
			'CL_AUTH_SECURE_COOKIE',
		),
		sessionTtlMs:
			integerEnvironment(
				environment.CL_AUTH_SESSION_TTL_HOURS,
				DEFAULT_SESSION_TTL_HOURS,
				'CL_AUTH_SESSION_TTL_HOURS',
				1,
				168,
			) *
			60 *
			60 *
			1000,
		sessionIdleMs:
			integerEnvironment(
				environment.CL_AUTH_SESSION_IDLE_MINUTES,
				DEFAULT_SESSION_IDLE_MINUTES,
				'CL_AUTH_SESSION_IDLE_MINUTES',
				5,
				1440,
			) *
			60 *
			1000,
		passwordMinLength: integerEnvironment(
			environment.CL_AUTH_PASSWORD_MIN_LENGTH,
			DEFAULT_PASSWORD_MIN_LENGTH,
			'CL_AUTH_PASSWORD_MIN_LENGTH',
			8,
			128,
		),
		// Public registration stays opt-in for production deployments.
		allowSignUp: booleanEnvironment(
			environment.CL_AUTH_ALLOW_SIGN_UP,
			!production,
			'CL_AUTH_ALLOW_SIGN_UP',
		),
		emailConfirmation,
		signInProviders: providersEnvironment(
			environment.CL_AUTH_SIGN_IN_PROVIDERS,
			'CL_AUTH_SIGN_IN_PROVIDERS',
		),
		oidcProviders: oidcProvidersEnvironment(environment.CL_AUTH_OIDC_PROVIDERS),
		...(locales ? { locales } : {}),
		workspaceRoot,
		trustProxy: booleanEnvironment(
			environment.CL_TRUST_PROXY,
			false,
			'CL_TRUST_PROXY',
		),
		mailTransport,
		...(mailDelivery ? { mailDelivery } : {}),
		...(environment.CL_AUTH_MFA_KEY
			? { mfaEncryptionKey: environment.CL_AUTH_MFA_KEY }
			: {}),
		...(publicBaseUrl ? { publicBaseUrl } : {}),
		production,
		contentSecurityPolicy:
			environment.CL_CSP?.trim() ||
			(production
				? PRODUCTION_CONTENT_SECURITY_POLICY
				: DEVELOPMENT_CONTENT_SECURITY_POLICY),
		contentSecurityPolicyReportOnly: booleanEnvironment(
			environment.CL_CSP_REPORT_ONLY,
			!production,
			'CL_CSP_REPORT_ONLY',
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

/* Standalone settings runtime backed by auth.db, for a composition root or a
   CLI that needs settings without the rest of the auth runtime. */
export function createModuleSettingsRuntime(options: {
	readonly databasePath: string;
}): ModuleSettingsRuntime {
	let repository: SqliteAuthRepository | undefined;
	const store = () =>
		(repository ??= new SqliteAuthRepository(options.databasePath));
	return createKernelSettingsRuntime({
		load: (tenantId, moduleId) => store().load(tenantId, moduleId),
		save: (record) => store().save(record),
		clear: (tenantId, moduleId, key) => store().clear(tenantId, moduleId, key),
	});
}

export function createAuthRuntime(
	options: AuthRuntimeOptions = authRuntimeOptionsFromEnvironment(),
): AuthRuntime {
	if (options.mfaEncryptionKey) {
		assertMfaEncryptionKey(options.mfaEncryptionKey, 'The MFA encryption key');
	}
	let repository: SqliteAuthRepository | undefined;
	let authService: AuthService | undefined;
	let sessionSweep: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	const store = () => {
		if (disposed) throw new Error('Auth runtime is disposed.');
		return (repository ??= new SqliteAuthRepository(options.databasePath));
	};
	const moduleSettings =
		options.settings ??
		createKernelSettingsRuntime({
			load: (tenantId, moduleId) => store().load(tenantId, moduleId),
			save: (record) => store().save(record),
			clear: (tenantId, moduleId, key) =>
				store().clear(tenantId, moduleId, key),
		});
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
			return (
				(options.mailTransport ?? options.mailDelivery !== undefined) &&
				read<boolean>('emailConfirmation')
			);
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
	const service = () => {
		if (!authService) {
			authService = new AuthService(store(), {
				policy,
				...(options.mfaEncryptionKey
					? { mfaEncryptionKey: options.mfaEncryptionKey }
					: {}),
				...(options.mailDelivery ? { mailDelivery: options.mailDelivery } : {}),
				...(options.publicBaseUrl
					? { publicBaseUrl: options.publicBaseUrl }
					: {}),
			});
			// Expired rows only matter for storage; the lookup already filters them.
			sessionSweep = setInterval(() => {
				try {
					authService?.deleteExpiredSessions();
				} catch (error) {
					/* Repository errors can contain SQL parameters. Keep the recurring
					   maintenance log useful without serializing the thrown value. */
					console.error(
						`[auth.core] expired session sweep failed (${error instanceof Error ? 'Error' : 'non-error'})`,
					);
				}
			}, EXPIRED_SESSION_SWEEP_MS);
			sessionSweep.unref();
		}
		return authService;
	};
	/* Settings writes are audited at the store owner, so the settings
	   administration API in system.core needs no audit dependency. */
	const detachSettingsAudit = moduleSettings.onChange((change) => {
		const membership = store().findAccountMembership(
			change.actor.accountId,
			change.actor.tenantId,
		);
		service().recordSettingsUpdate(
			{
				accountId: change.actor.accountId,
				tenantId: change.actor.tenantId,
				email: membership?.email ?? change.actor.accountId,
				role: membership?.role ?? '',
				scopes: membership?.scopes ?? [],
			},
			change.moduleId,
			change.key,
			change.cleared,
		);
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
	return {
		cookie,
		settings,
		moduleSettings,
		trustProxy: options.trustProxy ?? false,
		mailTransport: options.mailTransport ?? options.mailDelivery !== undefined,
		workspaceRoot: options.workspaceRoot ?? null,
		oidcProviders: options.oidcProviders ?? [],
		publicBaseUrl: options.publicBaseUrl ?? null,
		service,
		authorizeAgentToolAccess(tenantId, actor) {
			const identity = normalizeActor(actor);
			if (!identity || identity.kind !== 'user') return [];
			const membership = store().findAccountMembership(identity.id, tenantId);
			return membership?.status === 'active'
				? [...new Set(membership.scopes)].sort()
				: [];
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			detachSettingsAudit();
			if (sessionSweep) clearInterval(sessionSweep);
			sessionSweep = undefined;
			repository?.close();
			repository = undefined;
			authService = undefined;
		},
		middleware: (context, next) =>
			securityHeaders(context, () =>
				Promise.resolve(authentication(context, next)),
			),
	};
}
