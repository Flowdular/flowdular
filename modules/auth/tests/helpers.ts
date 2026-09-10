import { createContext } from '@octanejs/app-core';
import type { DatabaseProvider } from '@flowdular/database';
import { createModuleSettingsRuntime } from '@flowdular/kernel';
import { createAuthenticationMiddleware } from '../src/middleware/authentication.ts';
import { createAuthRoutes } from '../src/server/endpoints.ts';
import type { AuthRuntime } from '../src/server/runtime.ts';
import type { OidcProvider } from '../src/server/runtime.ts';
import { AuthService, type AuthPolicy } from '../src/services/auth-service.ts';
import type { DatabaseAuthRepository } from '../src/services/database-repository.ts';
import { createAuthSettingsStore } from '../src/services/settings-store.ts';
import { createAuthModuleSettings } from '../src/settings.ts';
import type { AuthMailDelivery } from '../src/services/mail-delivery.ts';
import {
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

export { closeAuthTestDatabases } from './support/database.ts';

export const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

export const ORIGIN = 'https://erp.example';

/* A provider for the cases that only construct a runtime, such as cookie naming
   and key validation. Opening it is the failure they are asserting against. */
export function unopenedDatabases(): DatabaseProvider {
	return {
		acquire: () =>
			Promise.reject(new Error('This runtime must not open a database.')),
		dispose: () => Promise.resolve(),
	};
}

export interface TestRuntime extends AuthRuntime {
	readonly database: AuthTestDatabase;
	readonly repository: DatabaseAuthRepository;
	readonly authService: AuthService;
	readonly policy: {
		sessionTtlMs: number;
		sessionIdleMs: number;
		passwordMinLength: number;
	};
	clock: { now: number };
}

export async function testRuntime(
	overrides: Partial<{
		allowSignUp: boolean;
		trustProxy: boolean;
		mailTransport: boolean;
		mailDelivery: AuthMailDelivery;
		mfaEncryptionKey: string;
		signInProviders: readonly string[];
		oidcProviders: readonly OidcProvider[];
		publicBaseUrl: string;
	}> = {},
): Promise<TestRuntime> {
	const database = await createAuthTestDatabase();
	const repository = database.repository;
	const clock = { now: 1_000_000 };
	const policy: AuthPolicy & {
		sessionTtlMs: number;
		sessionIdleMs: number;
		passwordMinLength: number;
	} = {
		sessionTtlMs: 12 * 60 * 60 * 1000,
		sessionIdleMs: 2 * 60 * 60 * 1000,
		passwordMinLength: 12,
	};
	const authService = new AuthService(repository, {
		passwordHash: fastHash,
		policy: () => policy,
		now: () => clock.now,
		...(overrides.mfaEncryptionKey
			? { mfaEncryptionKey: overrides.mfaEncryptionKey }
			: {}),
		...(overrides.mailDelivery ? { mailDelivery: overrides.mailDelivery } : {}),
	});
	const store = createAuthSettingsStore(() => Promise.resolve(repository));
	const moduleSettings = createModuleSettingsRuntime(store, {
		now: () => clock.now,
	});
	moduleSettings.declare(
		createAuthModuleSettings({
			allowSignUp: overrides.allowSignUp ?? true,
			signInProviders: overrides.signInProviders ?? [],
		}),
	);
	await store.prime('', 'auth.core');
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3600,
	};
	const service = () => Promise.resolve(authService);
	return {
		database,
		repository,
		authService,
		policy,
		clock,
		cookie,
		settingsAuditSettled: () => Promise.resolve(),
		settings: {
			get allowSignUp() {
				return moduleSettings.get<boolean>('', 'auth.core', 'allowSignUp');
			},
			emailConfirmation: false,
			signInProviders: overrides.signInProviders ?? [],
			get sessionTtlMs() {
				return policy.sessionTtlMs;
			},
			get sessionIdleMs() {
				return policy.sessionIdleMs;
			},
			get passwordMinLength() {
				return policy.passwordMinLength;
			},
		},
		moduleSettings,
		trustProxy: overrides.trustProxy ?? false,
		mailTransport:
			overrides.mailTransport ?? overrides.mailDelivery !== undefined,
		workspaceRoot: null,
		oidcProviders: overrides.oidcProviders ?? [],
		publicBaseUrl: overrides.publicBaseUrl ?? null,
		service,
		async authorizeAgentToolAccess(tenantId, actor) {
			if (actor.kind !== 'user') return [];
			const membership = await repository.findAccountMembership(
				actor.id,
				tenantId,
			);
			return membership?.status === 'active' ? membership.scopes : [];
		},
		async dispose() {
			await store.ready().catch(() => undefined);
			await database.dispose();
		},
		middleware: createAuthenticationMiddleware(service, cookie),
	};
}

export function route(runtime: AuthRuntime, path: string, method = 'GET') {
	const found = createAuthRoutes(runtime).find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes(method),
	);
	if (!found) throw new Error(`No route ${method} ${path}`);
	return found;
}

export function jsonRequest(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
	method = 'POST',
): Request {
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

/* The authentication middleware is what resolves the session and publishes it
   for the route guards, so a test request runs through it exactly as a served
   request does. */
export async function call(
	runtime: AuthRuntime,
	path: string,
	request: Request,
): Promise<Response> {
	const context = createContext(request, {});
	const handler = route(runtime, path, request.method).handler;
	return runtime.middleware(context, () =>
		Promise.resolve(handler(context)),
	) as Promise<Response>;
}

export interface SignedIn {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

export async function signUpOwner(
	runtime: AuthRuntime,
	email = 'owner@example.com',
	slug = 'example-operations',
): Promise<SignedIn> {
	const response = await call(
		runtime,
		'/api/auth/sign-up',
		jsonRequest('/api/auth/sign-up', {
			email,
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: slug,
		}),
	);
	if (response.status !== 201) {
		throw new Error(
			`sign-up failed: ${response.status} ${await response.text()}`,
		);
	}
	const body = (await response.json()) as {
		csrfToken: string;
		principal: { accountId: string; tenantId: string };
	};
	return {
		cookie: response.headers.get('set-cookie')!.split(';')[0]!,
		csrfToken: body.csrfToken,
		accountId: body.principal.accountId,
		tenantId: body.principal.tenantId,
	};
}

export function authed(
	session: SignedIn,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		cookie: session.cookie,
		'x-csrf-token': session.csrfToken,
		...extra,
	};
}
