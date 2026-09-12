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
import type { IdentityProviderSummary } from '../src/domain/types.ts';
import { oidcIssuerUnverified } from '../src/server/oidc.ts';
import { createProviderSecretVault } from '../src/services/provider-secrets.ts';
import type { OidcDiscoveryPort } from '../src/services/identity-provider-service.ts';
import {
	authed,
	call,
	closeAuthTestDatabases,
	jsonRequest,
	ORIGIN,
	route,
	signUpOwner,
	testRuntime,
	type SignedIn,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

const KEY = 'a1'.repeat(32);
const ISSUER = 'https://identity.example';
const PLATFORM_PROVIDER = {
	id: 'example',
	issuer: 'https://platform.example',
	authorizationEndpoint: 'https://platform.example/authorize',
	tokenEndpoint: 'https://platform.example/token',
	userInfoEndpoint: 'https://platform.example/userinfo',
	clientId: 'platform-client',
	clientSecret: 'platform-secret',
} as const;

const discovery: OidcDiscoveryPort = (issuer) =>
	Promise.resolve({
		authorizationEndpoint: `${issuer}/authorize`,
		tokenEndpoint: `${issuer}/token`,
		userInfoEndpoint: `${issuer}/userinfo`,
	});

const open = new Set<TestRuntime>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function fixture(
	overrides: Parameters<typeof testRuntime>[0] = {},
): Promise<TestRuntime> {
	const runtime = await testRuntime({
		mfaEncryptionKey: KEY,
		oidcDiscovery: discovery,
		publicBaseUrl: ORIGIN,
		...overrides,
	});
	open.add(runtime);
	return runtime;
}

interface ProviderBody {
	readonly provider?: IdentityProviderSummary;
	readonly providers?: readonly IdentityProviderSummary[];
	readonly error?: { readonly code: string; readonly message: string };
	readonly deleted?: boolean;
}

function create(
	runtime: TestRuntime,
	session: SignedIn,
	body: Record<string, unknown> = {},
): Promise<Response> {
	return call(
		runtime,
		'/api/auth/providers',
		jsonRequest(
			'/api/auth/providers',
			{
				key: 'workforce',
				label: 'Workforce',
				issuer: ISSUER,
				clientId: 'client-id',
				clientSecret: 'client-secret',
				...body,
			},
			authed(session),
		),
	);
}

function post(
	runtime: TestRuntime,
	path: string,
	session: SignedIn,
	body: Record<string, unknown>,
): Promise<Response> {
	return call(runtime, path, jsonRequest(path, body, authed(session)));
}

async function json(response: Response): Promise<ProviderBody> {
	return (await response.json()) as ProviderBody;
}

describe('AUTH-PROVIDER-TENANT-CRUD', () => {
	it('creates, updates, disables, enables, rotates and deletes a workspace provider', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);

		const created = await create(runtime, owner);
		expect(created.status).toBe(201);
		const provider = (await json(created)).provider!;
		expect(provider).toMatchObject({
			key: 'workforce',
			issuer: ISSUER,
			scope: 'tenant',
			status: 'active',
			jitEnabled: false,
		});
		/* The secret travelled once. Nothing in the answer carries it back, and
		   the fingerprint is over the secret, not over the envelope. */
		expect(JSON.stringify(provider)).not.toContain('client-secret');
		expect(provider.secretFingerprint).toBe(
			createProviderSecretVault(KEY).fingerprint('client-secret'),
		);

		const updated = await post(runtime, '/api/auth/providers/update', owner, {
			id: provider.id,
			label: 'Workforce SSO',
			issuer: ISSUER,
			clientId: 'client-id',
			jitEnabled: true,
			allowedDomains: ['Example.com'],
			jitRole: 'member',
		});
		expect(updated.status).toBe(200);
		expect((await json(updated)).provider).toMatchObject({
			label: 'Workforce SSO',
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'member',
			secretFingerprint: provider.secretFingerprint,
		});

		const deleteActive = await post(
			runtime,
			'/api/auth/providers/delete',
			owner,
			{ id: provider.id },
		);
		expect(deleteActive.status).toBe(409);
		expect((await json(deleteActive)).error?.code).toBe('PROVIDER_ACTIVE');

		const disabled = await post(runtime, '/api/auth/providers/disable', owner, {
			id: provider.id,
		});
		expect((await json(disabled)).provider?.status).toBe('disabled');
		const enabled = await post(runtime, '/api/auth/providers/enable', owner, {
			id: provider.id,
		});
		expect((await json(enabled)).provider?.status).toBe('active');

		const rotated = await post(
			runtime,
			'/api/auth/providers/rotate-secret',
			owner,
			{ id: provider.id, clientSecret: 'second-secret' },
		);
		expect(rotated.status).toBe(200);
		const after = (await json(rotated)).provider!;
		expect(after.secretFingerprint).not.toBe(provider.secretFingerprint);
		expect(JSON.stringify(after)).not.toContain('second-secret');

		await post(runtime, '/api/auth/providers/disable', owner, {
			id: provider.id,
		});
		const removed = await post(runtime, '/api/auth/providers/delete', owner, {
			id: provider.id,
		});
		expect(removed.status).toBe(200);
		expect(
			await runtime.repository.listIdentityProviders(owner.tenantId),
		).toEqual([]);
	});

	it('stores the secret sealed and never in the row that is read back', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);

		await create(runtime, owner);

		const [record] = await runtime.repository.listIdentityProviders(
			owner.tenantId,
		);
		expect(record!.secretCiphertext).not.toContain('client-secret');
		expect(record!.secretKeyId).toBe(createProviderSecretVault(KEY).keyId);
		/* The envelope is bound to the row: another workspace's context does not
		   open it, so a copied row is not portable. */
		const vault = createProviderSecretVault(KEY);
		expect(
			vault.open(
				{ tenantId: record!.tenantId, providerId: record!.id },
				record!.secretCiphertext,
				record!.secretKeyId,
			),
		).toBe('client-secret');
		expect(() =>
			vault.open(
				{ tenantId: 'another-tenant', providerId: record!.id },
				record!.secretCiphertext,
				record!.secretKeyId,
			),
		).toThrow(/provider secret/i);
	});

	it('refuses an issuer whose discovery document does not name it back', async () => {
		const runtime = await fixture({
			oidcDiscovery: () => Promise.reject(oidcIssuerUnverified()),
		});
		const owner = await signUpOwner(runtime);

		const response = await create(runtime, owner);

		expect(response.status).toBe(400);
		expect((await json(response)).error?.code).toBe(
			'PROVIDER_ISSUER_UNVERIFIED',
		);
		expect(
			await runtime.repository.listIdentityProviders(owner.tenantId),
		).toEqual([]);
	});

	it('refuses an invalid key, a bad domain list and an unknown role before anything is written', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);

		for (const body of [
			{ key: 'Not A Key' },
			{ jitEnabled: true, allowedDomains: [] },
			{ jitEnabled: true, allowedDomains: ['example.com'], jitRole: 'ghost' },
			{ clientSecret: undefined },
		]) {
			const response = await create(runtime, owner, body);
			expect(response.status).toBeGreaterThanOrEqual(400);
		}

		expect(
			await runtime.repository.listIdentityProviders(owner.tenantId),
		).toEqual([]);
	});

	it('refuses a second provider with the same key in one workspace', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		expect((await create(runtime, owner)).status).toBe(201);

		const duplicate = await create(runtime, owner);

		expect(duplicate.status).toBe(409);
		expect((await json(duplicate)).error?.code).toBe('PROVIDER_KEY_TAKEN');
	});
});

describe('AUTH-PROVIDER-TENANT-CRUD denials', () => {
	it('answers 401 without a session and 403 without the permission', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const member = await runtime.authService.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Mem Ber',
				role: 'member',
			},
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: 'owner@example.com',
				role: 'owner',
				scopes: ['users.members.manage'],
			},
		);
		expect(member.scopes).not.toContain('auth.providers.read');
		const signedIn = await call(
			runtime,
			'/api/auth/sign-in',
			jsonRequest('/api/auth/sign-in', {
				email: 'member@example.com',
				password: 'steady tangerine harbor',
			}),
		);
		const memberSession: SignedIn = {
			cookie: signedIn.headers.get('set-cookie')!.split(';')[0]!,
			csrfToken: ((await signedIn.json()) as { csrfToken: string }).csrfToken,
			accountId: member.accountId,
			tenantId: owner.tenantId,
		};

		const anonymous = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`),
		);
		expect(anonymous.status).toBe(401);

		const readDenied = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`, {
				headers: { cookie: memberSession.cookie },
			}),
		);
		expect(readDenied.status).toBe(403);
		expect((await json(readDenied)).error?.code).toBe('FORBIDDEN');

		const manageDenied = await create(runtime, memberSession);
		expect(manageDenied.status).toBe(403);
		expect(
			await runtime.repository.listIdentityProviders(owner.tenantId),
		).toEqual([]);
	});

	it('refuses a mutation without a CSRF proof and without an origin', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);

		const withoutCsrf = await call(
			runtime,
			'/api/auth/providers',
			jsonRequest(
				'/api/auth/providers',
				{ key: 'workforce' },
				{ cookie: owner.cookie },
			),
		);
		expect(withoutCsrf.status).toBe(403);
		expect((await json(withoutCsrf)).error?.code).toBe('CSRF_REJECTED');

		const crossOrigin = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://attacker.example',
					cookie: owner.cookie,
					'x-csrf-token': owner.csrfToken,
				},
				body: JSON.stringify({ key: 'workforce' }),
			}),
		);
		expect(crossOrigin.status).toBe(403);
		expect(
			await runtime.repository.listIdentityProviders(owner.tenantId),
		).toEqual([]);
	});

	it('answers for another workspace provider exactly as for an unknown one', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'second@example.com',
			'second-operations',
		);
		const created = (await json(await create(runtime, first))).provider!;

		const foreign = await post(runtime, '/api/auth/providers/update', second, {
			id: created.id,
			label: 'Taken over',
			issuer: ISSUER,
			clientId: 'client-id',
		});
		const unknown = await post(runtime, '/api/auth/providers/update', second, {
			id: 'a-provider-that-never-existed',
			label: 'Taken over',
			issuer: ISSUER,
			clientId: 'client-id',
		});

		expect(foreign.status).toBe(404);
		expect(await json(foreign)).toEqual(await json(unknown));
		expect(
			(await runtime.repository.listIdentityProviders(first.tenantId))[0]
				?.label,
		).toBe('Workforce');
		expect(
			await runtime.repository.listIdentityProviders(second.tenantId),
		).toEqual([]);
	});
});

describe('AUTH-PLATFORM-PROVIDERS', () => {
	it('lists a platform provider read-only beside the workspace providers', async () => {
		const runtime = await fixture({
			oidcProviders: [PLATFORM_PROVIDER],
			signInProviders: [PLATFORM_PROVIDER.id],
		});
		const owner = await signUpOwner(runtime);
		await create(runtime, owner);

		const response = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const providers = (await json(response)).providers!;

		expect(providers.map((entry) => [entry.key, entry.scope])).toEqual([
			['workforce', 'tenant'],
			['example', 'platform'],
		]);
		const platform = providers[1]!;
		expect(platform.status).toBe('active');
		expect(JSON.stringify(platform)).not.toContain(
			PLATFORM_PROVIDER.clientSecret,
		);
	});

	it('cannot change a platform provider through the workspace API', async () => {
		const runtime = await fixture({
			oidcProviders: [PLATFORM_PROVIDER],
			signInProviders: [PLATFORM_PROVIDER.id],
		});
		const owner = await signUpOwner(runtime);

		for (const path of [
			'/api/auth/providers/update',
			'/api/auth/providers/disable',
			'/api/auth/providers/rotate-secret',
			'/api/auth/providers/delete',
		]) {
			const response = await post(runtime, path, owner, {
				id: `platform:${PLATFORM_PROVIDER.id}`,
				label: 'Hijacked',
				issuer: ISSUER,
				clientId: 'client-id',
				clientSecret: 'new-secret',
			});
			expect([404, 400]).toContain(response.status);
		}

		expect(runtime.oidcProviders[0]).toEqual(PLATFORM_PROVIDER);
	});

	it('keeps the platform start route and its workspace-less binding', async () => {
		const runtime = await fixture({
			oidcProviders: [PLATFORM_PROVIDER],
			signInProviders: [PLATFORM_PROVIDER.id],
		});

		const response = await route(
			runtime,
			'/api/auth/oidc/:provider/start',
		).handler(
			createContext(new Request(`${ORIGIN}/api/auth/oidc/example/start`), {
				provider: PLATFORM_PROVIDER.id,
			}),
		);

		expect(response.status).toBe(302);
		const authorization = new URL(response.headers.get('location')!);
		expect(authorization.searchParams.get('redirect_uri')).toBe(
			`${ORIGIN}/api/auth/oidc/example/callback`,
		);
	});
});

describe('AUTH-PLATFORM-PROVIDERS secret fingerprint', () => {
	it('shows no fingerprint for a platform provider', async () => {
		const runtime = await fixture({
			oidcProviders: [PLATFORM_PROVIDER],
			signInProviders: [PLATFORM_PROVIDER.id],
		});
		const owner = await signUpOwner(runtime);
		await create(runtime, owner);

		const providers = (
			await json(
				await call(
					runtime,
					'/api/auth/providers',
					new Request(`${ORIGIN}/api/auth/providers`, {
						headers: { cookie: owner.cookie },
					}),
				),
			)
		).providers!;

		/* The deployment secret is one value shared by every workspace, so no
		   workspace is handed anything derived from it. A workspace secret is its
		   own and keeps its fingerprint. */
		const platform = providers.find((entry) => entry.scope === 'platform')!;
		expect(platform.secretFingerprint).toBe('');
		const owned = providers.find((entry) => entry.scope === 'tenant')!;
		expect(owned.secretFingerprint).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe('AUTH-PROVIDER-TENANT-CRUD partial update', () => {
	it('keeps JIT, domains, scopes and the client id when only the label is sent', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const before = (
			await json(
				await create(runtime, owner, {
					scopes: ['openid', 'email', 'profile', 'groups'],
					jitEnabled: true,
					allowedDomains: ['example.com', 'example.net'],
					jitRole: 'member',
				}),
			)
		).provider!;

		const updated = (
			await json(
				await post(runtime, '/api/auth/providers/update', owner, {
					id: before.id,
					label: 'Workforce EU',
				}),
			)
		).provider!;

		expect(updated).toMatchObject({
			label: 'Workforce EU',
			issuer: before.issuer,
			clientId: before.clientId,
			jitEnabled: true,
			jitRole: 'member',
			status: before.status,
			secretFingerprint: before.secretFingerprint,
		});
		expect(updated.allowedDomains).toEqual(['example.com', 'example.net']);
		expect(updated.scopes).toEqual(before.scopes);

		const stored = (
			await json(
				await call(
					runtime,
					'/api/auth/providers',
					new Request(`${ORIGIN}/api/auth/providers`, {
						headers: { cookie: owner.cookie },
					}),
				),
			)
		).providers!;
		expect(stored[0]).toMatchObject({
			label: 'Workforce EU',
			jitEnabled: true,
			allowedDomains: ['example.com', 'example.net'],
		});
	});

	it('validates the merged record, not only what was sent', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const before = (await json(await create(runtime, owner))).provider!;

		/* Provisioning is off and no domain is stored, so turning it on alone
		   cannot stand. */
		const refused = await post(runtime, '/api/auth/providers/update', owner, {
			id: before.id,
			jitEnabled: true,
		});
		expect(refused.status).toBe(400);
		expect((await json(refused)).error?.code).toBe('INVALID_INPUT');
	});
});

describe('AUTH-PROVIDER-TENANT-CRUD key cache invalidation', () => {
	it('forgets the cached key set of a provider on update and on delete', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const provider = (await json(await create(runtime, owner))).provider!;
		const forget = vi.spyOn(runtime.oidcVerifier, 'forget');

		await post(runtime, '/api/auth/providers/update', owner, {
			id: provider.id,
			issuer: 'https://identity.other.example',
		});
		expect(forget).toHaveBeenCalledWith(`${owner.tenantId}:workforce`);

		forget.mockClear();
		await post(runtime, '/api/auth/providers/disable', owner, {
			id: provider.id,
		});
		await post(runtime, '/api/auth/providers/delete', owner, {
			id: provider.id,
		});
		expect(forget).toHaveBeenCalledWith(`${owner.tenantId}:workforce`);
	});
});

describe('AUTH-PROVIDER-TENANT-CRUD role protection', () => {
	it('refuses deleting a role a provider provisions into', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const actor = {
			accountId: owner.accountId,
			tenantId: owner.tenantId,
			email: 'owner@example.com',
			role: 'owner',
			scopes: [
				...(await runtime.authService.listGrantableScopes(owner.tenantId)),
			],
		};
		const role = await runtime.authService.createRole(actor, {
			tenantId: owner.tenantId,
			key: 'joiner',
			name: 'Joiner',
			description: 'Joins through the provider.',
			scopes: ['auth.profile.read'],
		});
		await create(runtime, owner, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'joiner',
		});

		await expect(
			runtime.authService.deleteRole(actor, role.id),
		).rejects.toMatchObject({ code: 'ROLE_NAMED_BY_PROVIDER', status: 409 });
		expect(
			await runtime.repository.findRoleByKey(owner.tenantId, 'joiner'),
		).not.toBeNull();

		/* Pointing the provider elsewhere releases the role. */
		const provider = (
			await json(
				await call(
					runtime,
					'/api/auth/providers',
					new Request(`${ORIGIN}/api/auth/providers`, {
						headers: { cookie: owner.cookie },
					}),
				),
			)
		).providers![0]!;
		await post(runtime, '/api/auth/providers/update', owner, {
			id: provider.id,
			jitRole: 'member',
		});
		await expect(
			runtime.authService.deleteRole(actor, role.id),
		).resolves.toBeUndefined();
	});
});
