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
import type {
	IdentityProviderSummary,
	SignInProviderOption,
} from '../src/domain/types.ts';
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
const SUBJECT = 'workforce-subject-1';
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
	vi.unstubAllGlobals();
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

async function addProvider(
	runtime: TestRuntime,
	session: SignedIn,
	body: Record<string, unknown> = {},
): Promise<IdentityProviderSummary> {
	const response = await call(
		runtime,
		'/api/auth/providers',
		jsonRequest(
			'/api/auth/providers',
			{
				key: 'workforce',
				label: 'Workforce',
				issuer: 'https://identity.example',
				clientId: 'client-id',
				clientSecret: 'client-secret',
				...body,
			},
			authed(session),
		),
	);
	if (response.status !== 201) {
		throw new Error(`provider creation failed: ${await response.text()}`);
	}
	return ((await response.json()) as { provider: IdentityProviderSummary })
		.provider;
}

/* The provider's own responses. Verification of the signed token is covered by
   the identity suite; these cases are about which workspace the flow lands in. */
function providerFetch(email: string, subject = SUBJECT) {
	return vi.fn(async (input: RequestInfo | URL) =>
		String(input).endsWith('/token')
			? Response.json({
					access_token: 'provider-access-token',
					id_token: 'signed-id-token',
				})
			: Response.json({ sub: subject, email, email_verified: true }),
	);
}

function verifies(runtime: TestRuntime, subject = SUBJECT): void {
	vi.spyOn(runtime.oidcVerifier, 'verifyIdToken').mockResolvedValue({
		subject,
	});
}

interface Transaction {
	readonly cookie: string;
	readonly state: string;
	readonly location: string;
}

async function start(
	runtime: TestRuntime,
	workspace: string,
	key = 'workforce',
): Promise<Transaction> {
	const response = await route(
		runtime,
		'/api/auth/oidc/:workspace/:key/start',
	).handler(
		createContext(
			new Request(`${ORIGIN}/api/auth/oidc/${workspace}/${key}/start`),
			{ workspace, key },
		),
	);
	if (response.status !== 302) {
		throw new Error(`start failed: ${response.status}`);
	}
	const location = response.headers.get('location')!;
	return {
		cookie: response.headers.getSetCookie()[0]!.split(';')[0]!,
		state: new URL(location).searchParams.get('state')!,
		location,
	};
}

async function callback(
	runtime: TestRuntime,
	workspace: string,
	transaction: Transaction,
	key = 'workforce',
): Promise<Response> {
	return route(runtime, '/api/auth/oidc/:workspace/:key/callback').handler(
		createContext(
			new Request(
				`${ORIGIN}/api/auth/oidc/${workspace}/${key}/callback?code=code&state=${encodeURIComponent(transaction.state)}`,
				{ headers: { cookie: transaction.cookie } },
			),
			{ workspace, key },
		),
	);
}

function sessionToken(response: Response): string | null {
	const cookie = response.headers
		.getSetCookie()
		.find((entry) => entry.startsWith('coreloom_session_dev='));
	return cookie
		? decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!)
		: null;
}

async function configuration(
	runtime: TestRuntime,
	workspace?: string,
): Promise<{
	readonly workspace: { readonly slug: string; readonly name: string } | null;
	readonly providers: readonly SignInProviderOption[];
}> {
	const response = await call(
		runtime,
		'/api/auth/config',
		new Request(
			workspace
				? `${ORIGIN}/api/auth/config?workspace=${encodeURIComponent(workspace)}`
				: `${ORIGIN}/api/auth/config`,
		),
	);
	return (await response.json()) as {
		workspace: { slug: string; name: string } | null;
		providers: readonly SignInProviderOption[];
	};
}

describe('AUTH-SIGNIN-WORKSPACE-ROUTING', () => {
	it('offers only the named workspace providers beside the platform ones', async () => {
		const runtime = await fixture({
			oidcProviders: [PLATFORM_PROVIDER],
			signInProviders: [PLATFORM_PROVIDER.id],
		});
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'second@example.com',
			'second-operations',
		);
		await addProvider(runtime, first);
		await addProvider(runtime, second, { key: 'partners', label: 'Partners' });

		const one = await configuration(runtime, 'example-operations');
		const other = await configuration(runtime, 'second-operations');
		const none = await configuration(runtime);
		const unknown = await configuration(runtime, 'not-a-workspace');

		expect(one.workspace).toEqual({
			slug: 'example-operations',
			name: 'Example Operations',
		});
		expect(one.providers).toEqual([
			{
				key: 'workforce',
				label: 'Workforce',
				scope: 'tenant',
				startPath: '/api/auth/oidc/example-operations/workforce/start',
			},
			{
				key: 'example',
				label: 'example',
				scope: 'platform',
				startPath: '/api/auth/oidc/example/start',
			},
		]);
		expect(other.providers.map((entry) => entry.key)).toEqual([
			'partners',
			'example',
		]);
		/* An unknown workspace answers exactly as none at all. */
		expect(unknown).toEqual(none);
		expect(none.providers.map((entry) => entry.key)).toEqual(['example']);
		expect(first.tenantId).not.toBe(second.tenantId);
	});

	it('names the workspace and the provider in the authorization request', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		await addProvider(runtime, owner);

		const transaction = await start(runtime, 'example-operations');

		const authorization = new URL(transaction.location);
		expect(authorization.origin + authorization.pathname).toBe(
			'https://identity.example/authorize',
		);
		expect(authorization.searchParams.get('redirect_uri')).toBe(
			`${ORIGIN}/api/auth/oidc/example-operations/workforce/callback`,
		);
		expect(authorization.searchParams.get('scope')).toBe('openid email');
		expect(authorization.searchParams.get('client_id')).toBe('client-id');
		expect(transaction.cookie).toMatch(/^coreloom_oidc_state=/);
	});

	it('refuses a callback whose state names another workspace', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'second@example.com',
			'second-operations',
		);
		/* Both workspaces configure the same provider, so only the workspace the
		   state names can tell the two transactions apart. */
		await addProvider(runtime, first);
		await addProvider(runtime, second);
		const transaction = await start(runtime, 'example-operations');
		const fetchMock = providerFetch('owner@example.com');
		vi.stubGlobal('fetch', fetchMock);
		verifies(runtime);

		const response = await callback(runtime, 'second-operations', transaction);

		expect(response.status).toBe(401);
		expect(sessionToken(response)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a disabled provider and an unknown key before any exchange', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const provider = await addProvider(runtime, owner);
		await call(
			runtime,
			'/api/auth/providers/disable',
			jsonRequest(
				'/api/auth/providers/disable',
				{ id: provider.id },
				authed(owner),
			),
		);

		const disabled = await route(
			runtime,
			'/api/auth/oidc/:workspace/:key/start',
		).handler(
			createContext(
				new Request(
					`${ORIGIN}/api/auth/oidc/example-operations/workforce/start`,
				),
				{ workspace: 'example-operations', key: 'workforce' },
			),
		);
		const unknown = await route(
			runtime,
			'/api/auth/oidc/:workspace/:key/start',
		).handler(
			createContext(
				new Request(`${ORIGIN}/api/auth/oidc/example-operations/ghost/start`),
				{ workspace: 'example-operations', key: 'ghost' },
			),
		);

		expect(disabled.status).toBe(404);
		expect(await disabled.json()).toEqual(await unknown.json());
	});
});

describe('AUTH-OIDC-TENANT-BINDING', () => {
	it('binds the subject inside one workspace and opens a session there only', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'second@example.com',
			'second-operations',
		);
		await addProvider(runtime, first);
		await addProvider(runtime, second);
		vi.stubGlobal('fetch', providerFetch('owner@example.com'));
		verifies(runtime);

		const first_signIn = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);
		expect(first_signIn.status).toBe(302);
		const session = await runtime.authService.resolveSession(
			sessionToken(first_signIn)!,
		);
		expect(session?.principal.tenantId).toBe(first.tenantId);

		/* The binding lives in the workspace that made it. */
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				SUBJECT,
				first.tenantId,
			),
		).toBe(first.accountId);
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				SUBJECT,
				second.tenantId,
			),
		).toBeNull();

		const again = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);
		expect(
			(await runtime.authService.resolveSession(sessionToken(again)!))
				?.principal.tenantId,
		).toBe(first.tenantId);
	});

	it('refuses the same address in another workspace without a membership', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'second@example.com',
			'second-operations',
		);
		await addProvider(runtime, first);
		await addProvider(runtime, second);
		vi.stubGlobal('fetch', providerFetch('owner@example.com'));
		verifies(runtime);
		await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		const crossing = await callback(
			runtime,
			'second-operations',
			await start(runtime, 'second-operations'),
		);

		expect(crossing.status).toBe(401);
		expect(sessionToken(crossing)).toBeNull();
		expect(
			(await runtime.authService.listTenantMembers(second.tenantId)).map(
				(member) => member.email,
			),
		).toEqual(['second@example.com']);
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				SUBJECT,
				second.tenantId,
			),
		).toBeNull();
	});

	it('never rebinds an account already bound to another subject of the same provider', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		await addProvider(runtime, owner);
		vi.stubGlobal('fetch', providerFetch('owner@example.com'));
		verifies(runtime);
		await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		vi.stubGlobal('fetch', providerFetch('owner@example.com', 'rotated'));
		verifies(runtime, 'rotated');
		const rebind = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(rebind.status).toBe(401);
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				'rotated',
				owner.tenantId,
			),
		).toBeNull();
	});
});

describe('AUTH-JIT-PROVISION', () => {
	it('creates the member, its scopes and an audit row for an allowed domain', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		await addProvider(runtime, owner, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'member',
		});
		vi.stubGlobal('fetch', providerFetch('newcomer@example.com'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(302);
		const session = await runtime.authService.resolveSession(
			sessionToken(response)!,
		);
		expect(session?.principal).toMatchObject({
			email: 'newcomer@example.com',
			tenantId: owner.tenantId,
			role: 'member',
		});
		const members = await runtime.authService.listTenantMembers(owner.tenantId);
		const provisioned = members.find(
			(member) => member.email === 'newcomer@example.com',
		)!;
		expect(provisioned.membershipStatus).toBe('active');
		expect([...provisioned.scopes].sort()).toEqual(
			[
				...(await runtime.repository.findRoleByKey(owner.tenantId, 'member'))!
					.scopes,
			].sort(),
		);
		const audit = await runtime.authService.queryAudit({
			tenantId: owner.tenantId,
			limit: 20,
		});
		expect(
			audit.events.some(
				(event) =>
					event.action === 'auth.member.provisioned' &&
					event.subjectId === provisioned.accountId,
			),
		).toBe(true);
	});

	it('refuses a verified address outside the allowed domains before any write', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		await addProvider(runtime, owner, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'member',
		});
		vi.stubGlobal('fetch', providerFetch('outsider@other.example'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(401);
		expect(sessionToken(response)).toBeNull();
		expect(
			await runtime.repository.findAccountIdentity('outsider@other.example'),
		).toBeNull();
		expect(
			await runtime.authService.listTenantMembers(owner.tenantId),
		).toHaveLength(1);
	});

	it('reuses an account no workspace holds instead of creating a second one', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime);
		const second = await signUpOwner(
			runtime,
			'shared@example.com',
			'second-operations',
		);
		/* The account outlives its last membership; reuse is what keeps the
		   address from carrying a second account. */
		await runtime.repository.deleteMembership(
			second.accountId,
			second.tenantId,
		);
		await addProvider(runtime, first, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'member',
		});
		vi.stubGlobal('fetch', providerFetch('shared@example.com'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(302);
		const session = await runtime.authService.resolveSession(
			sessionToken(response)!,
		);
		expect(session?.principal.accountId).toBe(second.accountId);
		expect(session?.principal.tenantId).toBe(first.tenantId);
		expect(session?.principal.tenants.map((entry) => entry.tenantId)).toEqual([
			first.tenantId,
		]);
	});
});

describe('AUTH-JIT-NO-ABSORPTION', () => {
	it('refuses an address that already belongs to another workspace and audits the refusal', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const other = await signUpOwner(
			runtime,
			'shared@example.com',
			'second-operations',
		);
		await addProvider(runtime, owner, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'member',
		});
		vi.stubGlobal('fetch', providerFetch('shared@example.com'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: 'OIDC_AUTHENTICATION_FAILED',
				message: 'External sign-in could not be completed.',
			},
		});
		expect(sessionToken(response)).toBeNull();
		expect(
			(await runtime.authService.listTenantMembers(owner.tenantId)).map(
				(member) => member.email,
			),
		).toEqual(['owner@example.com']);
		/* The workspace the account does belong to is untouched. */
		expect(
			(await runtime.authService.listTenantMembers(other.tenantId)).map(
				(member) => member.email,
			),
		).toEqual(['shared@example.com']);
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				SUBJECT,
				owner.tenantId,
			),
		).toBeNull();
		const audit = await runtime.authService.queryAudit({
			tenantId: owner.tenantId,
			limit: 20,
		});
		expect(
			audit.events.some((event) => event.action === 'auth.member.provisioned'),
		).toBe(false);
		const refusal = audit.events.find(
			(event) => event.action === 'auth.jit.refused',
		);
		/* The provider row stores no configuring account, so the service actor
		   carries none. */
		expect(refusal).toMatchObject({
			actorKind: 'service',
			actorAccountId: null,
			configuredBy: null,
			subjectType: 'sign-in',
			subjectId: 'workforce',
			metadata: {
				provider: 'workforce',
				reason: 'account-has-other-membership',
			},
		});
		expect(JSON.stringify(refusal)).not.toContain('shared@example.com');
	});
});

describe('AUTH-JIT-DISABLED', () => {
	it('refuses an external sign-in without a membership and writes nothing', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		await addProvider(runtime, owner);
		vi.stubGlobal('fetch', providerFetch('newcomer@example.com'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: 'OIDC_AUTHENTICATION_FAILED',
				message: 'External sign-in could not be completed.',
			},
		});
		expect(sessionToken(response)).toBeNull();
		expect(
			await runtime.repository.findAccountIdentity('newcomer@example.com'),
		).toBeNull();
		expect(
			await runtime.authService.listTenantMembers(owner.tenantId),
		).toHaveLength(1);
		expect(
			await runtime.repository.findExternalIdentity(
				'workforce',
				SUBJECT,
				owner.tenantId,
			),
		).toBeNull();
	});
});

describe('AUTH-SIGNIN-WORKSPACE-ROUTING password sign-in', () => {
	/* The password form is routed by workspace exactly as the provider buttons
	   are: the workspace on the screen is the workspace the session opens in. */
	async function signIn(
		runtime: TestRuntime,
		body: Record<string, unknown>,
	): Promise<Response> {
		return call(
			runtime,
			'/api/auth/sign-in',
			jsonRequest('/api/auth/sign-in', body),
		);
	}

	async function actorOf(
		runtime: TestRuntime,
		session: SignedIn,
		email: string,
	) {
		return {
			accountId: session.accountId,
			tenantId: session.tenantId,
			email,
			role: 'owner',
			scopes: [
				...(await runtime.authService.listGrantableScopes(session.tenantId)),
			],
		};
	}

	/** The account, created in the first workspace and added to the second. */
	async function sharedAccount(
		runtime: TestRuntime,
		first: SignedIn,
		second: SignedIn,
	): Promise<void> {
		const created = await runtime.authService.createTenantMember(
			{
				tenantId: first.tenantId,
				email: 'shared@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Shared Person',
				role: 'member',
			},
			await actorOf(runtime, first, 'owner@example.com'),
		);
		const role = (await runtime.repository.findRoleByKey(
			second.tenantId,
			'member',
		))!;
		await runtime.repository.createMembershipInTenant({
			accountId: created.accountId,
			tenantId: second.tenantId,
			role: role.key,
			roleId: role.id,
			scopes: role.scopes,
			createdAt: runtime.clock.now,
		});
	}

	it('opens the session in the workspace the screen names, not the oldest membership', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime, 'owner@example.com', 'alpha-ops');
		const second = await signUpOwner(runtime, 'second@example.com', 'beta-ops');
		await sharedAccount(runtime, first, second);

		const beta = await signIn(runtime, {
			email: 'shared@example.com',
			password: 'steady tangerine harbor',
			workspace: 'beta-ops',
		});
		expect(beta.status).toBe(200);
		expect(
			((await beta.json()) as { principal: { tenantId: string } }).principal
				.tenantId,
		).toBe(second.tenantId);

		const alpha = await signIn(runtime, {
			email: 'shared@example.com',
			password: 'steady tangerine harbor',
			workspace: 'alpha-ops',
		});
		expect(
			((await alpha.json()) as { principal: { tenantId: string } }).principal
				.tenantId,
		).toBe(first.tenantId);

		/* No workspace named keeps whichever membership the routing read answers
		   with, exactly as before this field existed. */
		const routed =
			(await runtime.repository.findAccountByEmail('shared@example.com'))!;
		const unnamed = await signIn(runtime, {
			email: 'shared@example.com',
			password: 'steady tangerine harbor',
		});
		expect(
			((await unnamed.json()) as { principal: { tenantId: string } }).principal
				.tenantId,
		).toBe(routed.tenantId);
	});

	it('answers the generic credentials error for a workspace the account is not in', async () => {
		const runtime = await fixture();
		const first = await signUpOwner(runtime, 'owner@example.com', 'alpha-ops');
		await signUpOwner(runtime, 'second@example.com', 'beta-ops');
		await runtime.authService.createTenantMember(
			{
				tenantId: first.tenantId,
				email: 'shared@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Shared Person',
				role: 'member',
			},
			await actorOf(runtime, first, 'owner@example.com'),
		);

		for (const workspace of ['beta-ops', 'no-such-workspace']) {
			const response = await signIn(runtime, {
				email: 'shared@example.com',
				password: 'steady tangerine harbor',
				workspace,
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				error: {
					code: 'INVALID_CREDENTIALS',
					message: 'Email or password is incorrect.',
				},
			});
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});
});

describe('AUTH-JIT-PROVISION role drift', () => {
	it('records role-missing when the role a provider names is gone at sign-in', async () => {
		const runtime = await fixture();
		const owner = await signUpOwner(runtime);
		const role = await runtime.authService.createRole(
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: 'owner@example.com',
				role: 'owner',
				scopes: [
					...(await runtime.authService.listGrantableScopes(owner.tenantId)),
				],
			},
			{
				tenantId: owner.tenantId,
				key: 'joiner',
				name: 'Joiner',
				description: 'Joins through the provider.',
				scopes: ['auth.profile.read'],
			},
		);
		await addProvider(runtime, owner, {
			jitEnabled: true,
			allowedDomains: ['example.com'],
			jitRole: 'joiner',
		});
		/* The service refuses this deletion; the repository is used directly to
		   produce the drift a row written before that rule could still carry. */
		expect(await runtime.repository.deleteRole(owner.tenantId, role.id)).toBe(
			true,
		);
		vi.stubGlobal('fetch', providerFetch('newcomer@example.com'));
		verifies(runtime);

		const response = await callback(
			runtime,
			'example-operations',
			await start(runtime, 'example-operations'),
		);

		expect(response.status).toBe(401);
		const audit = await runtime.authService.queryAudit({
			tenantId: owner.tenantId,
			limit: 20,
		});
		const refusal = audit.events.find(
			(event) => event.action === 'auth.jit.refused',
		);
		expect(refusal?.metadata).toMatchObject({
			provider: 'workforce',
			reason: 'role-missing',
			role: 'joiner',
		});
		expect(
			await runtime.repository.findAccountIdentity('newcomer@example.com'),
		).toBeNull();
	});
});
