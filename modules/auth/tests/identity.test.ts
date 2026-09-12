import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createContext } from '@octanejs/app-core';
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	AUTH_TOKEN_PRINCIPAL_STATE_KEY,
} from '../src/middleware/authentication.ts';
import { createAuthRoutes } from '../src/server/endpoints.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	type AuthRuntime,
} from '../src/server/runtime.ts';
import {
	closeAuthTestDatabases,
	ORIGIN,
	route,
	testRuntime,
	unopenedDatabases,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

const OIDC_PROVIDER = {
	id: 'example',
	issuer: 'https://identity.example',
	authorizationEndpoint: 'https://identity.example/authorize',
	tokenEndpoint: 'https://identity.example/token',
	userInfoEndpoint: 'https://identity.example/userinfo',
	clientId: 'client',
	clientSecret: 'secret',
} as const;

const OIDC_DISCOVERY = `${OIDC_PROVIDER.issuer}/.well-known/openid-configuration`;
const OIDC_JWKS = `${OIDC_PROVIDER.issuer}/jwks`;
const OIDC_SUBJECT = 'provider-subject-1';
/* The runtime clock the suite fixes at 1_000_000 ms, in the seconds an ID
   token carries. */
const TOKEN_ISSUED_AT = 1_000;
const TOKEN_EXPIRES_AT = 1_300;

const providerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const providerJwk = {
	...(providerKeys.publicKey.export({ format: 'jwk' }) as Record<
		string,
		unknown
	>),
	kid: 'signing-key',
	alg: 'RS256',
	use: 'sig',
};

function signedIdToken(claims: Record<string, unknown>): string {
	const header = Buffer.from(
		JSON.stringify({ alg: 'RS256', kid: 'signing-key', typ: 'JWT' }),
		'utf8',
	).toString('base64url');
	const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
		'base64url',
	);
	const signature = sign(
		'sha256',
		Buffer.from(`${header}.${payload}`, 'ascii'),
		providerKeys.privateKey,
	).toString('base64url');
	return `${header}.${payload}.${signature}`;
}

function claimsFor(
	nonce: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iss: OIDC_PROVIDER.issuer,
		aud: OIDC_PROVIDER.clientId,
		sub: OIDC_SUBJECT,
		nonce,
		iat: TOKEN_ISSUED_AT,
		exp: TOKEN_EXPIRES_AT,
		...overrides,
	};
}

function idTokenFor(
	nonce: string,
	overrides: Record<string, unknown> = {},
): string {
	return signedIdToken(claimsFor(nonce, overrides));
}

function encodedSegment(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/* alg "none": a verifier that reads the header instead of deciding for itself
   accepts claims nobody signed. */
function unsignedIdToken(nonce: string): string {
	return `${encodedSegment({ alg: 'none', typ: 'JWT' })}.${encodedSegment(claimsFor(nonce))}.`;
}

/* The algorithm confusion forgery: the published RSA modulus is public, so a
   verifier that lets the header pick a symmetric algorithm verifies a token
   the attacker signed with it. */
function hmacForgedIdToken(nonce: string): string {
	const header = encodedSegment({
		alg: 'HS256',
		kid: 'signing-key',
		typ: 'JWT',
	});
	const payload = encodedSegment(claimsFor(nonce));
	const modulus = String((providerJwk as Record<string, unknown>).n);
	const signature = createHmac('sha256', modulus)
		.update(`${header}.${payload}`)
		.digest('base64url');
	return `${header}.${payload}.${signature}`;
}

async function oidcStart(runtime: TestRuntime) {
	const result = await route(runtime, '/api/auth/oidc/:provider/start').handler(
		createContext(new Request(`${ORIGIN}/api/auth/oidc/example/start`), {
			provider: OIDC_PROVIDER.id,
		}),
	);
	const authorization = new URL(result.headers.get('location')!);
	return {
		cookie: result.headers.getSetCookie()[0]!.split(';')[0]!,
		state: authorization.searchParams.get('state')!,
		nonce: authorization.searchParams.get('nonce')!,
	};
}

async function oidcCallback(
	runtime: TestRuntime,
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

function oidcProviderFetch(
	nonce: string,
	overrides: {
		readonly claims?: Record<string, unknown>;
		readonly profile?: Record<string, unknown>;
		readonly discovery?: Record<string, unknown>;
		readonly keys?: readonly unknown[];
		/** A token the provider never minted, served verbatim. */
		readonly idToken?: string;
	} = {},
) {
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const target = String(input);
		if (target === OIDC_DISCOVERY) {
			return Response.json({
				issuer: OIDC_PROVIDER.issuer,
				jwks_uri: OIDC_JWKS,
				...overrides.discovery,
			});
		}
		if (target === OIDC_JWKS)
			return Response.json({ keys: overrides.keys ?? [providerJwk] });
		if (target === OIDC_PROVIDER.tokenEndpoint) {
			return Response.json({
				access_token: 'provider-access-token',
				id_token:
					overrides.idToken ?? idTokenFor(nonce, overrides.claims ?? {}),
			});
		}
		return Response.json({
			sub: OIDC_SUBJECT,
			email: 'owner@example.com',
			email_verified: true,
			...overrides.profile,
		});
	});
}

const open = new Set<AuthRuntime>();

function track<T extends AuthRuntime>(runtime: T): T {
	open.add(runtime);
	return runtime;
}

/* Booting the embedded PostgreSQL takes seconds; charge it to the hook budget
   instead of the first case's five second timeout. */
beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

describe('Flowdular authentication identity', () => {
	it('uses the Flowdular request state keys', () => {
		expect(AUTH_PRINCIPAL_STATE_KEY).toBe('flowdular.auth.principal');
		expect(AUTH_TOKEN_PRINCIPAL_STATE_KEY).toBe(
			'flowdular.auth.token-principal',
		);
	});

	it('uses Flowdular session cookie names in development and production', () => {
		const base = {
			databases: unopenedDatabases(),
			sessionTtlMs: 3_600_000,
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		};
		const development = track(
			createAuthRuntime({ ...base, secureCookies: false }),
		);
		const production = track(
			createAuthRuntime({ ...base, secureCookies: true }),
		);

		expect(development.cookie.name).toBe('coreloom_session_dev');
		expect(production.cookie.name).toBe('__Host-coreloom_session');
	});

	it('rejects a malformed MFA encryption key before the runtime starts', () => {
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{ FD_AUTH_MFA_KEY: 'not-a-32-byte-key' },
				process.cwd(),
			),
		).toThrow(/FD_AUTH_MFA_KEY/);
		expect(() =>
			createAuthRuntime({
				databases: unopenedDatabases(),
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
				{ FD_AUTH_PUBLIC_ORIGIN: 'http://erp.example.test' },
				process.cwd(),
			),
		).toThrow(/HTTPS/);
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{ FD_AUTH_PUBLIC_ORIGIN: 'https://user:password@erp.example.test' },
				process.cwd(),
			),
		).toThrow(/credentials/);
		expect(
			authRuntimeOptionsFromEnvironment(
				{ FD_AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:4310' },
				process.cwd(),
			).publicBaseUrl,
		).toBe('http://127.0.0.1:4310');
	});

	it('uses a separate Flowdular cookie for the OIDC transaction', async () => {
		const runtime = track(
			createAuthRuntime({
				databases: await authTestProvider(),
				secureCookies: false,
				sessionTtlMs: 3_600_000,
				allowSignUp: false,
				emailConfirmation: false,
				signInProviders: ['example'],
				publicBaseUrl: 'https://flowdular.example',
				oidcProviders: [OIDC_PROVIDER],
			}),
		);
		const route = createAuthRoutes(runtime).find(
			(entry) => entry.path === '/api/auth/oidc/:provider/start',
		)!;
		const context = createContext(
			new Request('https://flowdular.example/api/auth/oidc/example/start'),
			{ provider: 'example' },
		);

		const response = await route.handler(context);

		expect(response.status).toBe(302);
		expect(response.headers.get('set-cookie')).toMatch(/^coreloom_oidc_state=/);
	});

	it('rejects a modified OIDC transaction before contacting the provider and expires its cookie', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
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
	});

	it('rejects an oversized OIDC authorization code before contacting the provider', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
		const transaction = await oidcStart(runtime);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await oidcCallback(runtime, transaction, {
			code: 'x'.repeat(4_097),
		});

		expect(result.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns the session and expired OIDC state as separate Set-Cookie headers', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
		await runtime.authService.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Owner',
			organizationName: 'Example',
			organizationSlug: 'example',
		});
		const transaction = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch(transaction.nonce));

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
	});

	it('returns the MFA proof and expired OIDC state as separate Set-Cookie headers', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
		vi.spyOn(runtime.authService, 'signInExternalIdentity').mockResolvedValue({
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
		vi.stubGlobal('fetch', oidcProviderFetch(transaction.nonce));

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
	});

	it('puts a deadline on every OIDC provider request', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
		const transaction = await oidcStart(runtime);
		const fetchMock = oidcProviderFetch(transaction.nonce);
		vi.stubGlobal('fetch', fetchMock);

		await oidcCallback(runtime, transaction);

		/* Token exchange, discovery, the key set, and the profile. */
		expect(fetchMock).toHaveBeenCalledTimes(4);
		for (const [, init] of fetchMock.mock.calls) {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it('rejects an OIDC provider response larger than the identity bound', async () => {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
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
	});

	it('refuses an OIDC provider configured without an issuer', () => {
		expect(() =>
			authRuntimeOptionsFromEnvironment(
				{
					FD_AUTH_OIDC_PROVIDERS: JSON.stringify([
						{
							id: 'example',
							authorizationEndpoint: 'https://identity.example/authorize',
							tokenEndpoint: 'https://identity.example/token',
							userInfoEndpoint: 'https://identity.example/userinfo',
							clientId: 'client',
							clientSecret: 'secret',
						},
					]),
				},
				process.cwd(),
			),
		).toThrow(/incomplete/);
	});
});

describe('OIDC identity token verification', () => {
	async function signedUpRuntime(): Promise<TestRuntime> {
		const runtime = track(
			await testRuntime({
				signInProviders: [OIDC_PROVIDER.id],
				oidcProviders: [OIDC_PROVIDER],
				publicBaseUrl: ORIGIN,
			}),
		);
		await runtime.authService.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Owner',
			organizationName: 'Example',
			organizationSlug: 'example',
		});
		return runtime;
	}

	async function rejected(
		runtime: TestRuntime,
		fetchMock: ReturnType<typeof oidcProviderFetch>,
		transaction: Awaited<ReturnType<typeof oidcStart>>,
	): Promise<void> {
		vi.stubGlobal('fetch', fetchMock);
		const result = await oidcCallback(runtime, transaction);
		expect(result.status).toBe(401);
		expect(await result.json()).toEqual({
			error: {
				code: 'OIDC_AUTHENTICATION_FAILED',
				message: 'External sign-in could not be completed.',
			},
		});
	}

	it('accepts a correctly signed token and records the provider subject', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch(transaction.nonce));

		const result = await oidcCallback(runtime, transaction);

		expect(result.status).toBe(302);
		expect(
			await runtime.repository.findExternalIdentity('example', OIDC_SUBJECT),
		).not.toBeNull();
	});

	it('refuses a token signed by a key the provider does not publish', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);
		const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				keys: [
					{
						...(foreign.publicKey.export({ format: 'jwk' }) as Record<
							string,
							unknown
						>),
						kid: 'signing-key',
						alg: 'RS256',
					},
				],
			}),
			transaction,
		);
	});

	it('refuses a token that carries no signature at all', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				idToken: unsignedIdToken(transaction.nonce),
			}),
			transaction,
		);
	});

	it('refuses a token signed with the published key as a symmetric secret', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				idToken: hmacForgedIdToken(transaction.nonce),
			}),
			transaction,
		);
	});

	/* An audience list means the token was minted for another party too, and
	   only the authorized party may present it here. */
	it('refuses an audience list whose authorized party is another client', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				claims: {
					aud: [OIDC_PROVIDER.clientId, 'another-client'],
					azp: 'another-client',
				},
			}),
			transaction,
		);
	});

	it('refuses a token whose nonce is not the one this transaction asked for', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch('another-transaction-nonce'),
			transaction,
		);
	});

	it('refuses a foreign issuer, a foreign audience, and a stale token', async () => {
		/* Expiry and issue time are compared with the five minute skew the
		   verifier allows, so both cases sit well outside it. */
		for (const claims of [
			{ iss: 'https://attacker.example' },
			{ aud: 'another-client' },
			{ exp: TOKEN_ISSUED_AT - 600 },
			{ iat: TOKEN_ISSUED_AT + 3_600 },
		]) {
			const runtime = await signedUpRuntime();
			const transaction = await oidcStart(runtime);
			await rejected(
				runtime,
				oidcProviderFetch(transaction.nonce, { claims }),
				transaction,
			);
		}
	});

	it('refuses a discovery document that names another issuer', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				discovery: { issuer: 'https://attacker.example' },
			}),
			transaction,
		);
	});

	it('refuses a profile whose subject is not the one the token named', async () => {
		const runtime = await signedUpRuntime();
		const transaction = await oidcStart(runtime);

		await rejected(
			runtime,
			oidcProviderFetch(transaction.nonce, {
				profile: { sub: 'another-subject' },
			}),
			transaction,
		);
	});

	it('follows the subject after the provider reports another address', async () => {
		const runtime = await signedUpRuntime();
		const first = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch(first.nonce));
		expect((await oidcCallback(runtime, first)).status).toBe(302);

		const second = await oidcStart(runtime);
		vi.stubGlobal(
			'fetch',
			oidcProviderFetch(second.nonce, {
				profile: { email: 'renamed@example.com' },
			}),
		);
		const result = await oidcCallback(runtime, second);

		expect(result.status).toBe(302);
		expect(
			await runtime.repository.findExternalIdentitySubject(
				'example',
				(await runtime.repository.findAccountByEmail('owner@example.com'))!
					.accountId,
			),
		).toBe(OIDC_SUBJECT);
	});

	it('refuses to bind a second provider subject to a linked account', async () => {
		const runtime = await signedUpRuntime();
		const first = await oidcStart(runtime);
		vi.stubGlobal('fetch', oidcProviderFetch(first.nonce));
		expect((await oidcCallback(runtime, first)).status).toBe(302);

		const second = await oidcStart(runtime);
		await rejected(
			runtime,
			oidcProviderFetch(second.nonce, {
				claims: { sub: 'rotated-subject' },
				profile: { sub: 'rotated-subject' },
			}),
			second,
		);
	});
});
