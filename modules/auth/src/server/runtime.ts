import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Middleware } from '@octanejs/app-core';
import {
	createModuleSettingsRuntime as createKernelSettingsRuntime,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@coreloom/kernel';
import {
	createSecurityHeadersMiddleware,
	DEVELOPMENT_CONTENT_SECURITY_POLICY,
	PRODUCTION_CONTENT_SECURITY_POLICY,
} from '@coreloom/server';
import { createAuthenticationMiddleware } from '../middleware/authentication.ts';
import { AuthService, type AuthPolicy } from '../services/auth-service.ts';
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
	readonly production?: boolean;
	readonly contentSecurityPolicy?: string | null;
	readonly contentSecurityPolicyReportOnly?: boolean;
	/** Share an existing settings runtime instead of opening one on auth.db. */
	readonly settings?: ModuleSettingsRuntime;
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
	service(): AuthService;
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
	const mailTransport = false;
	const emailConfirmation = booleanEnvironment(
		environment.OERP_AUTH_EMAIL_CONFIRMATION,
		false,
		'OERP_AUTH_EMAIL_CONFIRMATION',
	);
	if (emailConfirmation && !mailTransport) {
		throw new Error(
			'OERP_AUTH_EMAIL_CONFIRMATION requires a composed mail transport; none is available.',
		);
	}
	const locales = workspaceLocales(workspaceRoot);
	return {
		databasePath:
			environment.OERP_AUTH_DATABASE ??
			(production
				? '/data/auth.db'
				: resolve(workspaceRoot, '.octane-erp/auth.db')),
		secureCookies: booleanEnvironment(
			environment.OERP_AUTH_SECURE_COOKIE,
			production,
			'OERP_AUTH_SECURE_COOKIE',
		),
		sessionTtlMs:
			integerEnvironment(
				environment.OERP_AUTH_SESSION_TTL_HOURS,
				DEFAULT_SESSION_TTL_HOURS,
				'OERP_AUTH_SESSION_TTL_HOURS',
				1,
				168,
			) *
			60 *
			60 *
			1000,
		sessionIdleMs:
			integerEnvironment(
				environment.OERP_AUTH_SESSION_IDLE_MINUTES,
				DEFAULT_SESSION_IDLE_MINUTES,
				'OERP_AUTH_SESSION_IDLE_MINUTES',
				5,
				1440,
			) *
			60 *
			1000,
		passwordMinLength: integerEnvironment(
			environment.OERP_AUTH_PASSWORD_MIN_LENGTH,
			DEFAULT_PASSWORD_MIN_LENGTH,
			'OERP_AUTH_PASSWORD_MIN_LENGTH',
			8,
			128,
		),
		// Public registration stays opt-in for production deployments.
		allowSignUp: booleanEnvironment(
			environment.OERP_AUTH_ALLOW_SIGN_UP,
			!production,
			'OERP_AUTH_ALLOW_SIGN_UP',
		),
		emailConfirmation,
		signInProviders: providersEnvironment(
			environment.OERP_AUTH_SIGN_IN_PROVIDERS,
			'OERP_AUTH_SIGN_IN_PROVIDERS',
		),
		...(locales ? { locales } : {}),
		workspaceRoot,
		trustProxy: booleanEnvironment(
			environment.OERP_TRUST_PROXY,
			false,
			'OERP_TRUST_PROXY',
		),
		mailTransport,
		production,
		contentSecurityPolicy:
			environment.OERP_CSP?.trim() ||
			(production
				? PRODUCTION_CONTENT_SECURITY_POLICY
				: DEVELOPMENT_CONTENT_SECURITY_POLICY),
		contentSecurityPolicyReportOnly: booleanEnvironment(
			environment.OERP_CSP_REPORT_ONLY,
			!production,
			'OERP_CSP_REPORT_ONLY',
		),
	};
}

function cookieName(options: AuthRuntimeOptions): string {
	const configured = options.cookieName?.trim();
	if (!configured) {
		return options.secureCookies ? '__Host-oerp_session' : 'oerp_session_dev';
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
	let repository: SqliteAuthRepository | undefined;
	let authService: AuthService | undefined;
	const store = () =>
		(repository ??= new SqliteAuthRepository(options.databasePath));
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
				(options.mailTransport ?? false) && read<boolean>('emailConfirmation')
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
			authService = new AuthService(store(), { policy });
			// Expired rows only matter for storage; the lookup already filters them.
			setInterval(() => {
				try {
					authService?.deleteExpiredSessions();
				} catch (error) {
					console.error('[auth.core] expired session sweep failed', error);
				}
			}, EXPIRED_SESSION_SWEEP_MS).unref();
		}
		return authService;
	};
	/* Settings writes are audited at the store owner, so the settings
	   administration API in system.core needs no audit dependency. */
	moduleSettings.onChange((change) => {
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
		mailTransport: options.mailTransport ?? false,
		workspaceRoot: options.workspaceRoot ?? null,
		service,
		middleware: (context, next) =>
			securityHeaders(context, () =>
				Promise.resolve(authentication(context, next)),
			),
	};
}
