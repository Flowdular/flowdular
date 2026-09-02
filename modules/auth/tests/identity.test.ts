import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createContext } from '@octanejs/app-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	AUTH_TOKEN_PRINCIPAL_STATE_KEY,
} from '../src/middleware/authentication.ts';
import { createAuthRoutes } from '../src/server/endpoints.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '../src/server/runtime.ts';
import { ORIGIN, route, testRuntime } from './helpers.ts';

const OIDC_PROVIDER = {
	id: 'example',
	authorizationEndpoint: 'https://identity.example/authorize',
	tokenEndpoint: 'https://identity.example/token',
	userInfoEndpoint: 'https://identity.example/userinfo',
	clientId: 'client',
	clientSecret: 'secret',
} as const;

async function oidcStart(runtime: ReturnType<typeof testRuntime>) {
	const result = await route(runtime, '/api/auth/oidc/:provider/start').handler(
		createContext(new Request(`${ORIGIN}/api/auth/oidc/example/start`), {
			provider: OIDC_PROVIDER.id,
		}),
	);
	return {
		cookie: result.headers.getSetCookie()[0]!.split(';')[0]!,
		state: new URL(result.headers.get('location')!).searchParams.get('state')!,
	};
}

async function oidcCallback(
	runtime: ReturnType<typeof testRuntime>,
	transaction: { readonly cookie: string; readonly state: string },
	values: { readonly code?: string; readonly state?: string } = {},
) {
	const code = values.code ?? 'code';
	const state = values.state ?? transaction.state;
	return route(runtime, '/api/auth/oidc/:provider/callback').handler(
		createContext(
			new Request(
				`${ORIGIN}/api/auth/oidc/example/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
				{ headers: { cookie: transaction.cookie } },
			),
			{ provider: OIDC_PROVIDER.id },
		),
	);
}

function oidcProviderFetch() {
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
		String(input) === OIDC_PROVIDER.tokenEndpoint
			? Response.json({ access_token: 'provider-access-token' })
			: Response.json({
					email: 'owner@example.com',
					email_verified: true,
				}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Coreloom authentication identity', () => {
	it('uses the Coreloom local data path and request state keys', () => {
		const workspace = mkdtempSync(resolve(tmpdir(), 'coreloom-auth-identity-'));
		try {
			const options = authRuntimeOptionsFromEnvironment({}, workspace);

			expect(options.databasePath).toBe(
				resolve(workspace, '.coreloom/data/auth.db'),
			);
			expect(AUTH_PRINCIPAL_STATE_KEY).toBe('coreloom.auth.principal');
			expect(AUTH_TOKEN_PRINCIPAL_STATE_KEY).toBe(
				'coreloom.auth.token-principal',
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it('uses Coreloom session cookie names in development and production', () => {
		const base = {
			databasePath: ':memory:',
			sessionTtlMs: 3_600_000,
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		};
		const development = createAuthRuntime({ ...base, secureCookies: false });
		const production = createAuthRuntime({ ...base, secureCookies: true });

		expect(development.cookie.name).toBe('coreloom_session_dev');
		expect(production.cookie.name).toBe('__Host-coreloom_session');
		development.dispose();
		production.dispose();
	});

	it('rejects a malformed MFA encryption key before the runtime starts', () => {
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{ CL_AUTH_MFA_KEY: 'not-a-32-byte-key' },
				process.cwd(),
			),
		).toThrow(/CL_AUTH_MFA_KEY/);
		expect(() =>
			createAuthRuntime({
				databasePath: ':memory:',
				secureCookies: false,
				sessionTtlMs: 3_600_000,
				allowSignUp: false,
				emailConfirmation: false,
				signInProviders: [],
				mfaEncryptionKey: 'not-a-32-byte-key',
			}),
		).toThrow(/MFA encryption key/);
	});

	it('requires a secure canonical public origin for auth links and OIDC', () => {
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{ CL_AUTH_PUBLIC_ORIGIN: 'http://erp.example.test' },
				process.cwd(),
			),
		).toThrow(/HTTPS/);
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{ CL_AUTH_PUBLIC_ORIGIN: 'https://user:password@erp.example.test' },
				process.cwd(),
			),
		).toThrow(/credentials/);
		expect(
			authRuntimeOptionsFromEnvironment(
				{ CL_AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:4310' },
				process.cwd(),
			).publicBaseUrl,
		).toBe('http://127.0.0.1:4310');
	});

	it('uses a separate Coreloom cookie for the OIDC transaction', async () => {
		const runtime = createAuthRuntime({
			databasePath: ':memory:',
			secureCookies: false,
			sessionTtlMs: 3_600_000,
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: ['example'],
			publicBaseUrl: 'https://coreloom.example',
			oidcProviders: [
				{
					id: 'example',
					authorizationEndpoint: 'https://identity.example/authorize',
					tokenEndpoint: 'https://identity.example/token',
					userInfoEndpoint: 'https://identity.example/userinfo',
					clientId: 'client',
					clientSecret: 'secret',
				},
			],
		});
		const route = createAuthRoutes(runtime).find(
			(entry) => entry.path === '/api/auth/oidc/:provider/start',
		)!;
		const context = createContext(
			new Request('https://coreloom.example/api/auth/oidc/example/start'),
			{ provider: 'example' },
		);

		const response = await route.handler(context);

		expect(response.status).toBe(302);
		expect(response.headers.get('set-cookie')).toMatch(/^coreloom_oidc_state=/);
		runtime.dispose();
	});

	it('rejects a modified OIDC transaction before contacting the provider and expires its cookie', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		const transaction = await oidcStart(runtime);
		const cookie = transaction.cookie;
		const [name, encodedValue] = cookie.split('=', 2) as [string, string];
		const value = decodeURIComponent(encodedValue);
		/* In the legacy JSON cookie this changes only the PKCE verifier. In the
		   sealed cookie it changes the MAC. Neither change may reach the provider. */
		const pivot = value.length - 2;
		const replacement = value[pivot] === 'A' ? 'B' : 'A';
		const modified =
			value.slice(0, pivot) + replacement + value.slice(pivot + 1);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await oidcCallback(runtime, {
			state: transaction.state,
			cookie: `${name}=${encodeURIComponent(modified)}`,
		});

		expect(result.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.headers.getSetCookie()).toEqual([
			expect.stringContaining('coreloom_oidc_state='),
		]);
		expect(result.headers.getSetCookie()[0]).toContain('Max-Age=0');
		runtime.dispose();
	});

	it('rejects an oversized OIDC authorization code before contacting the provider', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		const transaction = await oidcStart(runtime);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await oidcCallback(runtime, transaction, {
			code: 'x'.repeat(4_097),
		});

		expect(result.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('returns the session and expired OIDC state as separate Set-Cookie headers', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		await runtime.authService.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Owner',
			organizationName: 'Example',
			organizationSlug: 'example',
		});
		const transaction = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch());

		const result = await oidcCallback(runtime, transaction);
		const cookies = result.headers.getSetCookie();

		expect(result.status).toBe(302);
		expect(result.headers.get('location')).toBe('/app');
		expect(cookies).toHaveLength(2);
		expect(cookies).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^coreloom_session_dev=/),
				expect.stringMatching(/^coreloom_oidc_state=.*Max-Age=0/),
			]),
		);
		runtime.dispose();
	});

	it('returns the MFA proof and expired OIDC state as separate Set-Cookie headers', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		vi.spyOn(
			runtime.authService,
			'signInVerifiedExternalEmail',
		).mockResolvedValue({
			mfaRequired: true,
			token: 'A'.repeat(43),
			csrfToken: '',
			sessionId: '',
			expiresAt: 1_300_000,
			passwordChangeRequired: false,
			principal: {
				accountId: 'account-1',
				tenantId: 'tenant-1',
				email: 'owner@example.com',
				displayName: 'Owner',
				role: 'owner',
				scopes: [],
				tenants: [],
			},
		});
		const transaction = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch());

		const result = await oidcCallback(runtime, transaction);
		const cookies = result.headers.getSetCookie();

		expect(result.status).toBe(302);
		expect(result.headers.get('location')).toBe('/auth/mfa?mfa=oidc');
		expect(cookies).toHaveLength(2);
		expect(cookies).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^coreloom_mfa_challenge=/),
				expect.stringMatching(/^coreloom_oidc_state=.*Max-Age=0/),
			]),
		);
		runtime.dispose();
	});

	it('puts a deadline on both OIDC provider requests', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		const transaction = await oidcStart(runtime);
		const fetchMock = oidcProviderFetch();
		vi.stubGlobal('fetch', fetchMock);

		await oidcCallback(runtime, transaction);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [, init] of fetchMock.mock.calls) {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
		runtime.dispose();
	});

	it('rejects an OIDC provider response larger than the identity bound', async () => {
		const runtime = testRuntime({
			signInProviders: [OIDC_PROVIDER.id],
			oidcProviders: [OIDC_PROVIDER],
			publicBaseUrl: ORIGIN,
		});
		await runtime.authService.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Owner',
			organizationName: 'Example',
			organizationSlug: 'example',
		});
		const transaction = await oidcStart(runtime);
		const oversized =
			' '.repeat(70 * 1024) +
			JSON.stringify({ access_token: 'provider-access-token' });
		const fetchMock = vi.fn(async () => new Response(oversized));
		vi.stubGlobal('fetch', fetchMock);

		const result = await oidcCallback(runtime, transaction);

		expect(result.status).toBe(401);
		expect(await result.json()).toEqual({
			error: {
				code: 'OIDC_AUTHENTICATION_FAILED',
				message: 'External sign-in could not be completed.',
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});
});
