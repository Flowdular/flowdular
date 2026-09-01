import { createContext } from '@octanejs/app-core';
import { createModuleSettingsRuntime } from '@coreloom/kernel';
import { createAuthenticationMiddleware } from '../src/middleware/authentication.ts';
import { createAuthRoutes } from '../src/server/endpoints.ts';
import type { AuthRuntime } from '../src/server/runtime.ts';
import { AuthService, type AuthPolicy } from '../src/services/auth-service.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';
import { createAuthModuleSettings } from '../src/settings.ts';

export const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

export const ORIGIN = 'https://erp.example';

export interface TestRuntime extends AuthRuntime {
	readonly repository: SqliteAuthRepository;
	readonly authService: AuthService;
	readonly policy: {
		sessionTtlMs: number;
		sessionIdleMs: number;
		passwordMinLength: number;
	};
	clock: { now: number };
}

export function testRuntime(
	overrides: Partial<{
		allowSignUp: boolean;
		trustProxy: boolean;
		mailTransport: boolean;
	}> = {},
): TestRuntime {
	const repository = new SqliteAuthRepository(':memory:');
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
	});
	const moduleSettings = createModuleSettingsRuntime(repository, {
		now: () => clock.now,
	});
	moduleSettings.declare(
		createAuthModuleSettings({ allowSignUp: overrides.allowSignUp ?? true }),
	);
	const cookie = {
		name: 'oerp_session_dev',
		secure: false,
		maxAgeSeconds: 3600,
	};
	return {
		repository,
		authService,
		policy,
		clock,
		cookie,
		settings: {
			get allowSignUp() {
				return moduleSettings.get<boolean>('', 'auth.core', 'allowSignUp');
			},
			emailConfirmation: false,
			signInProviders: [],
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
		mailTransport: overrides.mailTransport ?? false,
		workspaceRoot: null,
		service: () => authService,
		middleware: createAuthenticationMiddleware(() => authService, cookie),
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

export async function call(
	runtime: AuthRuntime,
	path: string,
	request: Request,
): Promise<Response> {
	return route(runtime, path, request.method).handler(
		createContext(request, {}),
	);
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
