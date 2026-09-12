import { createContext } from '@octanejs/app-core';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	createAuthRoutes,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserRoutes } from '../src/api/endpoints.ts';
import { moduleDefinition } from '../src/index.ts';

const ORIGIN = 'https://erp.example';

const opened: { runtime: AuthRuntime; databases: DatabaseProvider }[] = [];

afterEach(async () => {
	for (const entry of opened.splice(0)) {
		await entry.runtime.dispose();
		await entry.databases.dispose();
	}
});

/* The auth runtime is composed from its public server entry over an embedded
   PostgreSQL, the same way the platform composes it, so these tests exercise
   the real administration port and never reach into auth.core internals. */
async function authRuntime(): Promise<AuthRuntime> {
	const databases = createPgliteTestProvider();
	const runtime = createAuthRuntime({
		databases,
		purpose: 'test',
		secureCookies: false,
		cookieName: 'coreloom_session_dev',
		sessionTtlMs: 3_600_000,
		sessionIdleMs: 3_600_000,
		passwordMinLength: 12,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	opened.push({ runtime, databases });
	return runtime;
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

/* The member drawer's Reset MFA action posts to auth.core's administration
   route with the same member management scope the users API requires. */
async function callAuthMutation(
	auth: AuthRuntime,
	path: string,
	session: Session | null,
	body: unknown,
): Promise<Response> {
	const route = createAuthRoutes(auth).find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes('POST'),
	);
	if (!route) throw new Error(`auth.core exposes no POST ${path}.`);
	const context = createContext(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				...(session
					? { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
					: {}),
			},
			body: JSON.stringify(body),
		}),
		{},
	);
	return (await auth.middleware(context, () =>
		Promise.resolve(route.handler(context)),
	)) as Response;
}

async function signInMember(
	auth: AuthRuntime,
	email: string,
	password: string,
): Promise<Session> {
	const issued = await (await auth.service()).signIn({ email, password });
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
			password: 'quiet lantern voyage',
			displayName: 'Man Ager',
			role: 'member',
		});
		expect(created.status).toBe(201);
		const manager = ((await created.json()) as { user: { accountId: string } })
			.user;
		await (
			await auth.service()
		).setMembershipScopes(
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
			'quiet lantern voyage',
		);
		const escalation = await callUsers(
			auth,
			'/api/users',
			'POST',
			managerSession,
			{
				email: 'evil@example.com',
				password: 'brisk copper meadow',
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

		const token = await (
			await auth.service()
		).issueApiToken({
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
			password: 'steady tangerine harbor',
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
		const session = await (
			await auth.service()
		).signIn({
			email: 'member@example.com',
			password: 'temporary pass 1234',
		});
		expect(session.passwordChangeRequired).toBe(true);
		const removed = await callUsers(auth, '/api/users/remove', 'POST', owner, {
			accountId: member.accountId,
		});
		expect(removed.status).toBe(200);
		expect(
			await (await auth.service()).resolveSession(session.token),
		).toBeNull();
	});

	it('USERS-MEMBERSHIP-STATUS: disables one workspace membership and leaves the account and the other workspace alone', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		await signUp(auth, 'other@example.com', 'workspace-two');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const service = await auth.service();
		const elsewhere = await service.provisionMember({
			workspace: 'workspace-two',
			email: 'member@example.com',
			role: 'member',
			operator: 'tests',
		});
		const session = await service.signIn({
			email: 'member@example.com',
			password: 'steady tangerine harbor',
		});
		const token = await service.issueApiToken({
			tenantId: owner.tenantId,
			accountId: member.accountId,
			label: 'Workspace one automation',
			scopes: ['system.workspace.access'],
			expiresAt: null,
			createdBy: owner.accountId,
		});

		const disabled = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: member.accountId, status: 'disabled' },
		);
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toEqual({
			membership: { accountId: member.accountId, status: 'disabled' },
		});
		expect(await service.resolveSession(session.token)).toBeNull();
		expect(await service.resolveApiToken(token.token)).toBeNull();

		const listed = (await (
			await callUsers(auth, '/api/users', 'GET', owner)
		).json()) as { users: readonly TenantMember[] };
		const row = listed.users.find(
			(user) => user.accountId === member.accountId,
		)!;
		expect(row.membershipStatus).toBe('disabled');
		/* The global block is the operator's and stays where it was. */
		expect(row.status).toBe('active');

		const elsewhereMembers = await service.listTenantMembers(
			elsewhere.workspace.tenantId,
		);
		expect(
			elsewhereMembers.find((user) => user.accountId === member.accountId)
				?.membershipStatus,
		).toBe('active');

		/* Refused outright or resolved to the workspace that still has them; what
		   must never happen again is a session in the workspace that disabled it. */
		const landed = await service
			.signIn({
				email: 'member@example.com',
				password: 'steady tangerine harbor',
			})
			.then((issued) => issued.principal.tenantId)
			.catch(() => null);
		expect(landed).not.toBe(owner.tenantId);

		const enabled = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: member.accountId, status: 'active' },
		);
		expect(enabled.status).toBe(200);
		const restored = (await (
			await callUsers(auth, '/api/users', 'GET', owner)
		).json()) as { users: readonly TenantMember[] };
		expect(
			restored.users.find((user) => user.accountId === member.accountId)
				?.membershipStatus,
		).toBe('active');
		await expect(
			service.signIn({
				email: 'member@example.com',
				password: 'steady tangerine harbor',
			}),
		).resolves.toMatchObject({ principal: { tenantId: owner.tenantId } });
		/* Re-enabling restores sign-in, never a revoked token. */
		expect(await service.resolveApiToken(token.token)).toBeNull();
	});

	it('USERS-MEMBERSHIP-STATUS: refuses the acting principal, a foreign account, and an anonymous caller', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const other = await signUp(auth, 'other@example.com', 'workspace-two');

		const itself = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: owner.accountId, status: 'disabled' },
		);
		expect(itself.ok).toBe(false);
		expect(await itself.json()).toMatchObject({
			error: { code: 'SELF_TARGET' },
		});

		const foreign = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: other.accountId, status: 'disabled' },
		);
		expect(foreign.ok).toBe(false);
		expect(await foreign.json()).toMatchObject({
			error: { code: 'ACCOUNT_NOT_FOUND' },
		});

		const anonymous = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			null,
			{ accountId: other.accountId, status: 'disabled' },
		);
		expect(anonymous.status).toBe(401);
		const untouched = (await (
			await callUsers(auth, '/api/users', 'GET', other)
		).json()) as { users: readonly TenantMember[] };
		expect(untouched.users[0]?.membershipStatus).toBe('active');
	});

	it('clears another member MFA factor for a member manager and denies the rest', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const memberSession = await signInMember(
			auth,
			'member@example.com',
			'steady tangerine harbor',
		);

		const allowed = await callAuthMutation(auth, '/api/auth/mfa/reset', owner, {
			accountId: member.accountId,
		});
		const denied = await callAuthMutation(
			auth,
			'/api/auth/mfa/reset',
			memberSession,
			{ accountId: owner.accountId },
		);
		const anonymous = await callAuthMutation(
			auth,
			'/api/auth/mfa/reset',
			null,
			{
				accountId: member.accountId,
			},
		);

		expect(allowed.status).toBe(200);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
		expect(anonymous.status).toBe(401);
	});
});
