import { createContext } from '@octanejs/app-core';
import { createModuleSettingsRuntime } from '@coreloom/kernel';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	createAuthenticationMiddleware,
	createAuthRoutes,
} from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { createUserRoutes } from '../src/api/endpoints.ts';
import { moduleDefinition } from '../src/index.ts';

const ORIGIN = 'https://erp.example';

/* The auth runtime is composed from its public server entry, the same way the
   platform composes it, so these tests exercise the real administration port. */
async function authRuntime(): Promise<AuthRuntime> {
	const { AuthService } = await import(
		'../../auth/src/services/auth-service.ts'
	);
	const { SqliteAuthRepository } = await import(
		'../../auth/src/services/sqlite-repository.ts'
	);
	const { createAuthModuleSettings } = await import(
		'../../auth/src/settings.ts'
	);
	const repository = new SqliteAuthRepository(':memory:');
	const service = new AuthService(repository, {
		passwordHash: {
			cost: 2 ** 12,
			blockSize: 8,
			parallelization: 1,
			keyLength: 32,
			maxMemory: 32 * 1024 * 1024,
		},
	});
	const moduleSettings = createModuleSettingsRuntime(repository);
	moduleSettings.declare(createAuthModuleSettings());
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3600,
	};
	return {
		cookie,
		settings: {
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			sessionTtlMs: 3_600_000,
			sessionIdleMs: 3_600_000,
			passwordMinLength: 12,
		},
		moduleSettings,
		trustProxy: false,
		mailTransport: false,
		workspaceRoot: null,
		oidcProviders: [],
		publicBaseUrl: null,
		service: () => service,
		authorizeAgentToolAccess: () => [],
		middleware: createAuthenticationMiddleware(() => service, cookie),
		dispose: () => undefined,
	};
}

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

async function signUp(
	auth: AuthRuntime,
	email: string,
	slug: string,
): Promise<Session> {
	const signUpRoute = createAuthRoutes(auth).find(
		(route) => route.path === '/api/auth/sign-up',
	)!;
	const response = await signUpRoute.handler(
		createContext(
			new Request(`${ORIGIN}/api/auth/sign-up`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({
					email,
					password: 'correct horse battery staple',
					displayName: 'Owner Person',
					organizationName: 'Workspace',
					organizationSlug: slug,
				}),
			}),
			{},
		),
	);
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

async function callUsers(
	auth: AuthRuntime,
	path: string,
	method: string,
	session: Session | null,
	body?: unknown,
): Promise<Response> {
	const route = createUserRoutes(auth).find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes(method),
	)!;
	const request = new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(session
				? { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
				: {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const context = createContext(request, {});
	// Run the auth middleware the platform registers so the principal is set.
	await auth.middleware(context, async () => new Response(null));
	return route.handler(context);
}

async function signInMember(
	auth: AuthRuntime,
	email: string,
	password: string,
): Promise<Session> {
	const issued = await auth.service().signIn({ email, password });
	return {
		cookie: `coreloom_session_dev=${issued.token}`,
		csrfToken: issued.csrfToken,
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
	};
}

describe('users.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('users.core');
	});

	it('lists the directory with roles, scopes, and the acting principal', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const response = await callUsers(auth, '/api/users', 'GET', owner);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			users: { email: string; scopes: string[] }[];
			roles: { key: string }[];
			grantableScopes: string[];
			actor: { accountId: string; role: string };
			passwordMinLength: number;
		};
		expect(body.users.map((user) => user.email)).toEqual(['owner@example.com']);
		expect(body.users[0]?.scopes).toContain('users.members.manage');
		expect(body.roles.map((role) => role.key)).toEqual(['owner', 'member']);
		expect(body.grantableScopes).toContain('auth.roles.manage');
		expect(body.actor).toEqual({ accountId: owner.accountId, role: 'owner' });
		expect(body.passwordMinLength).toBe(12);
		expect((await callUsers(auth, '/api/users', 'GET', null)).status).toBe(401);
	});

	it('caps owner creation to owners and denies token principals', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'manager@example.com',
			password: 'manager password long',
			displayName: 'Man Ager',
			role: 'member',
		});
		expect(created.status).toBe(201);
		const manager = ((await created.json()) as { user: { accountId: string } })
			.user;
		auth.service().setMembershipScopes(
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: 'owner@example.com',
				role: 'owner',
				scopes: [],
			},
			manager.accountId,
			['users.members.read', 'users.members.manage', 'system.workspace.access'],
		);
		const managerSession = await signInMember(
			auth,
			'manager@example.com',
			'manager password long',
		);
		const escalation = await callUsers(
			auth,
			'/api/users',
			'POST',
			managerSession,
			{
				email: 'evil@example.com',
				password: 'evil password long enough',
				displayName: 'Evil Owner',
				role: 'owner',
			},
		);
		expect(escalation.status).toBe(403);
		expect(await escalation.json()).toMatchObject({
			error: { code: 'OWNER_REQUIRED' },
		});
		const promote = await callUsers(
			auth,
			'/api/users/role',
			'POST',
			managerSession,
			{
				accountId: manager.accountId,
				role: 'owner',
			},
		);
		expect(promote.status).toBe(400);
		const editOwner = await callUsers(
			auth,
			'/api/users/update',
			'POST',
			managerSession,
			{ accountId: owner.accountId, displayName: 'Hijacked' },
		);
		expect(editOwner.status).toBe(403);
		const capped = await callUsers(
			auth,
			'/api/users/scopes',
			'POST',
			managerSession,
			{ accountId: owner.accountId, scopes: ['auth.tokens.manage'] },
		);
		expect(capped.status).toBe(403);

		const token = auth.service().issueApiToken({
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: 'Automation',
			scopes: ['users.members.manage'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		const route = createUserRoutes(auth).find(
			(candidate) =>
				candidate.path === '/api/users/status' &&
				candidate.methods.includes('POST'),
		)!;
		const context = createContext(
			new Request(`${ORIGIN}/api/users/status`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					authorization: `Bearer ${token.token}`,
				},
				body: JSON.stringify({
					accountId: manager.accountId,
					status: 'disabled',
				}),
			}),
			{},
		);
		await auth.middleware(context, async () => new Response(null));
		const viaToken = await route.handler(context);
		expect(viaToken.status).toBe(403);
		expect(await viaToken.json()).toMatchObject({
			error: { code: 'TOKEN_MUTATION_DENIED' },
		});
	});

	it('keeps member administration inside the acting tenant', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const other = await signUp(auth, 'other@example.com', 'workspace-two');
		const foreign = await callUsers(auth, '/api/users/update', 'POST', other, {
			accountId: owner.accountId,
			displayName: 'Renamed by a stranger',
		});
		expect(foreign.status).toBe(404);
		const disable = await callUsers(auth, '/api/users/status', 'POST', other, {
			accountId: owner.accountId,
			status: 'disabled',
		});
		expect(disable.status).toBe(404);
		const remove = await callUsers(auth, '/api/users/remove', 'POST', other, {
			accountId: owner.accountId,
		});
		expect(remove.status).toBe(404);
		const list = (await (
			await callUsers(auth, '/api/users', 'GET', other)
		).json()) as { users: { email: string }[] };
		expect(list.users.map((user) => user.email)).toEqual(['other@example.com']);
	});

	it('resets a member password and forces a change at the next sign-in', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'member password long',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const reset = await callUsers(
			auth,
			'/api/users/password-reset',
			'POST',
			owner,
			{ accountId: member.accountId, temporaryPassword: 'temporary pass 1234' },
		);
		expect(reset.status).toBe(200);
		const resetText = await reset.text();
		expect(JSON.parse(resetText)).toMatchObject({
			user: { passwordChangeRequired: true },
		});
		expect(resetText).not.toContain('temporary pass');
		const session = await auth.service().signIn({
			email: 'member@example.com',
			password: 'temporary pass 1234',
		});
		expect(session.passwordChangeRequired).toBe(true);
		const removed = await callUsers(auth, '/api/users/remove', 'POST', owner, {
			accountId: member.accountId,
		});
		expect(removed.status).toBe(200);
		expect(auth.service().resolveSession(session.token)).toBeNull();
	});
});
