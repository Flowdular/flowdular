import { randomUUID } from 'node:crypto';
import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '../src/server/runtime.ts';
import {
	authed,
	call,
	jsonRequest,
	ORIGIN,
	signUpOwner,
	testRuntime,
} from './helpers.ts';

describe('auth HTTP boundary', () => {
	it('creates, reads, and revokes a protected cookie session', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		const sessionResponse = await call(
			auth,
			'/api/auth/session',
			new Request(`${ORIGIN}/api/auth/session`, {
				headers: { cookie: owner.cookie },
			}),
		);
		expect(sessionResponse.status).toBe(200);
		const sessionBody = (await sessionResponse.json()) as {
			sessionId: string;
			passwordChangeRequired: boolean;
			tenantSettings: Record<string, unknown>;
		};
		expect(sessionBody.sessionId).toMatch(/[0-9a-f-]{36}/);
		expect(sessionBody.passwordChangeRequired).toBe(false);
		expect(sessionBody.tenantSettings).toEqual({ defaultLocale: 'en' });

		const secondTenantId = randomUUID();
		auth.repository.createTenantMembership({
			accountId: owner.accountId,
			tenantId: secondTenantId,
			organizationName: 'Second Workspace',
			organizationSlug: 'second-workspace',
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: Date.now() + 1,
		});
		const switched = await call(
			auth,
			'/api/auth/switch-tenant',
			jsonRequest(
				'/api/auth/switch-tenant',
				{ tenantId: secondTenantId },
				authed(owner),
			),
		);
		expect(switched.status).toBe(200);
		const switchedCookie = switched.headers.get('set-cookie')!.split(';')[0]!;
		const switchedBody = (await switched.json()) as {
			csrfToken: string;
			principal: { tenantId: string };
		};
		expect(switchedBody.principal.tenantId).toBe(secondTenantId);

		const revoked = await call(
			auth,
			'/api/auth/sign-out',
			new Request(`${ORIGIN}/api/auth/sign-out`, {
				method: 'POST',
				headers: {
					cookie: switchedCookie,
					origin: ORIGIN,
					'x-csrf-token': switchedBody.csrfToken,
				},
			}),
		);
		expect(revoked.status).toBe(200);
		expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('rejects cross-origin sign-up before account work', async () => {
		const auth = testRuntime();
		const response = await call(
			auth,
			'/api/auth/sign-up',
			jsonRequest(
				'/api/auth/sign-up',
				{},
				{ origin: 'https://attacker.example' },
			),
		);
		expect(response.status).toBe(403);
	});

	it('enforces the sign-up module setting at the server boundary', async () => {
		const auth = testRuntime({ allowSignUp: false });
		const response = await call(
			auth,
			'/api/auth/sign-up',
			jsonRequest('/api/auth/sign-up', {}),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'SIGN_UP_DISABLED' },
		});
	});

	it('does not confirm registered addresses through sign-up or sign-in', async () => {
		const auth = testRuntime();
		await signUpOwner(auth);
		const duplicate = await call(
			auth,
			'/api/auth/sign-up',
			jsonRequest('/api/auth/sign-up', {
				email: 'owner@example.com',
				password: 'another long password',
				displayName: 'Impostor',
				organizationName: 'Other',
				organizationSlug: 'other-workspace',
			}),
		);
		expect(duplicate.status).toBe(400);
		const duplicateBody = (await duplicate.json()) as {
			error: { code: string; message: string };
		};
		expect(duplicateBody.error.code).toBe('SIGN_UP_REJECTED');
		expect(duplicateBody.error.message).not.toMatch(/exists/i);

		const known = await call(
			auth,
			'/api/auth/sign-in',
			jsonRequest('/api/auth/sign-in', {
				email: 'owner@example.com',
				password: 'wrong password entirely',
			}),
		);
		const unknown = await call(
			auth,
			'/api/auth/sign-in',
			jsonRequest('/api/auth/sign-in', {
				email: 'nobody@example.com',
				password: 'wrong password entirely',
			}),
		);
		expect(known.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(await known.json()).toEqual(await unknown.json());
	});

	it('caps request bodies and reports 413', async () => {
		const auth = testRuntime();
		const response = await call(
			auth,
			'/api/auth/sign-in',
			jsonRequest('/api/auth/sign-in', {
				email: 'owner@example.com',
				password: 'x'.repeat(20_000),
			}),
		);
		expect(response.status).toBe(413);
	});

	it('locks an address after repeated failures with a stable error', async () => {
		const auth = testRuntime();
		await signUpOwner(auth, 'lock@example.com', 'lock-workspace');
		const attempt = () =>
			call(
				auth,
				'/api/auth/sign-in',
				jsonRequest('/api/auth/sign-in', {
					email: 'lock@example.com',
					password: 'not the password',
				}),
			);
		// The request limiter allows five attempts per window; the fifth failure
		// trips the account lock.
		for (let index = 0; index < 4; index += 1) {
			expect((await attempt()).status).toBe(401);
		}
		const locked = await attempt();
		expect(locked.status).toBe(401);
		const sixth = await attempt();
		expect(sixth.status).toBe(429);
		const service = auth.service();
		await expect(
			service.signIn({
				email: 'lock@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED', status: 423 });
		auth.clock.now += 16 * 60 * 1000;
		await expect(
			service.signIn({
				email: 'lock@example.com',
				password: 'correct horse battery staple',
			}),
		).resolves.toMatchObject({ principal: { email: 'lock@example.com' } });
	});

	it('limits by forwarded client address only behind a trusted proxy', async () => {
		const attempts = async (trustProxy: boolean) => {
			const auth = testRuntime({ trustProxy });
			const statuses: number[] = [];
			for (let index = 0; index < 25; index += 1) {
				const response = await call(
					auth,
					'/api/auth/sign-in',
					jsonRequest(
						'/api/auth/sign-in',
						{
							email: `user${index}-${trustProxy}@example.com`,
							password: 'not the password',
						},
						{ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
					),
				);
				statuses.push(response.status);
			}
			return statuses;
		};
		expect(
			(await attempts(true)).filter((status) => status === 429),
		).toHaveLength(5);
		expect(
			(await attempts(false)).filter((status) => status === 429),
		).toHaveLength(0);
	});

	it('adds security headers through the composed auth middleware', async () => {
		const runtime = createAuthRuntime({
			databasePath: ':memory:',
			secureCookies: true,
			cookieName: '__Host-test',
			sessionTtlMs: 3_600_000,
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
			production: true,
		});
		const response = await runtime.middleware(
			createContext(new Request('https://erp.example/'), {}),
			async () => new Response('<html></html>'),
		);
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('strict-transport-security')).toContain(
			'max-age',
		);
		expect(response.headers.get('content-security-policy')).toContain(
			"frame-ancestors 'none'",
		);
		expect(runtime.settings.allowSignUp).toBe(false);
	});

	it('refuses to enable email confirmation without a mail transport', () => {
		const runtime = createAuthRuntime({
			databasePath: ':memory:',
			secureCookies: false,
			sessionTtlMs: 3_600_000,
			allowSignUp: true,
			emailConfirmation: true,
			signInProviders: [],
		});
		expect(runtime.settings.emailConfirmation).toBe(false);
		expect(() =>
			authRuntimeOptionsFromEnvironment({
				OERP_AUTH_EMAIL_CONFIRMATION: 'true',
			}),
		).toThrow(/mail transport/);
	});
});

describe('workspace settings', () => {
	it('renames the workspace and serves the tenant locale in the session', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		const renamed = await call(
			auth,
			'/api/auth/workspace',
			jsonRequest(
				'/api/auth/workspace',
				{ name: 'Renamed Operations' },
				authed(owner),
			),
		);
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({
			tenant: { tenantId: owner.tenantId, name: 'Renamed Operations' },
		});

		auth.moduleSettings.set(
			owner.tenantId,
			'auth.core',
			'defaultLocale',
			'pl',
			owner.accountId,
		);
		const session = await call(
			auth,
			'/api/auth/session',
			new Request(`${ORIGIN}/api/auth/session`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const body = (await session.json()) as {
			tenantSettings: Record<string, unknown>;
		};
		expect(body.tenantSettings).toEqual({ defaultLocale: 'pl' });
	});

	it('denies the rename without the manage scope', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		await auth.service().createTenantMember({
			tenantId: owner.tenantId,
			email: 'member@example.com',
			password: 'member password long',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const memberSession = await auth.service().signIn({
			email: 'member@example.com',
			password: 'member password long',
		});
		const denied = await call(
			auth,
			'/api/auth/workspace',
			jsonRequest(
				'/api/auth/workspace',
				{ name: 'Hijacked' },
				{
					cookie: `oerp_session_dev=${memberSession.token}`,
					'x-csrf-token': memberSession.csrfToken,
				},
			),
		);
		expect(denied.status).toBe(403);
	});
});

describe('roles, audit, and sessions API', () => {
	it('manages custom roles over HTTP and keeps them tenant-scoped', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		const created = await call(
			auth,
			'/api/auth/roles',
			jsonRequest(
				'/api/auth/roles',
				{
					key: 'auditor',
					name: 'Auditor',
					description: 'Reads audit trails',
					scopes: ['auth.audit.read', 'users.members.read'],
				},
				authed(owner),
			),
		);
		expect(created.status).toBe(201);
		const role = ((await created.json()) as { role: { id: string } }).role;
		const listed = await call(
			auth,
			'/api/auth/roles',
			new Request(`${ORIGIN}/api/auth/roles`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const roles = (await listed.json()) as {
			roles: { key: string; builtin: boolean }[];
			grantableScopes: string[];
		};
		expect(roles.roles.map((entry) => entry.key)).toEqual([
			'owner',
			'member',
			'auditor',
		]);
		expect(roles.grantableScopes).toContain('auth.roles.manage');

		const other = await signUpOwner(
			auth,
			'other@example.com',
			'other-workspace',
		);
		const foreign = await call(
			auth,
			'/api/auth/roles/update',
			jsonRequest(
				'/api/auth/roles/update',
				{ id: role.id, name: 'Hijacked' },
				authed(other),
			),
		);
		expect(foreign.status).toBe(404);
		const deleted = await call(
			auth,
			'/api/auth/roles/delete',
			jsonRequest('/api/auth/roles/delete', { id: role.id }, authed(owner)),
		);
		expect(deleted.status).toBe(200);
	});

	it('pages the audit trail newest first and filters by action', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		for (let index = 0; index < 3; index += 1) {
			auth.clock.now += 1;
			auth.service().renameTenant(
				{
					accountId: owner.accountId,
					tenantId: owner.tenantId,
					email: 'owner@example.com',
					role: 'owner',
					scopes: OWNER_SCOPES,
				},
				`Workspace ${index}`,
			);
		}
		const first = await call(
			auth,
			'/api/auth/audit',
			new Request(`${ORIGIN}/api/auth/audit?limit=2`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const firstPage = (await first.json()) as {
			events: { action: string }[];
			nextCursor: string | null;
			actions: string[];
		};
		expect(firstPage.events).toHaveLength(2);
		expect(firstPage.events[0]?.action).toBe('auth.tenant.renamed');
		expect(firstPage.nextCursor).not.toBeNull();
		expect(firstPage.actions).toContain('auth.sign-in.failed');
		const second = await call(
			auth,
			'/api/auth/audit',
			new Request(
				`${ORIGIN}/api/auth/audit?limit=2&cursor=${firstPage.nextCursor}&action=auth.tenant.renamed`,
				{ headers: { cookie: owner.cookie } },
			),
		);
		const secondPage = (await second.json()) as {
			events: { action: string }[];
			nextCursor: string | null;
		};
		expect(secondPage.events).toHaveLength(1);
		expect(secondPage.nextCursor).toBeNull();
	});

	it('lists own sessions and revokes another one', async () => {
		const auth = testRuntime();
		const owner = await signUpOwner(auth);
		const second = await auth.service().signIn({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
		});
		const listed = await call(
			auth,
			'/api/auth/sessions',
			new Request(`${ORIGIN}/api/auth/sessions`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const sessions = (await listed.json()) as {
			currentSessionId: string;
			sessions: { id: string; current: boolean }[];
		};
		expect(sessions.sessions).toHaveLength(2);
		expect(sessions.sessions.filter((session) => session.current)).toHaveLength(
			1,
		);
		const revoke = await call(
			auth,
			'/api/auth/sessions/revoke',
			jsonRequest(
				'/api/auth/sessions/revoke',
				{ id: second.sessionId },
				authed(owner),
			),
		);
		expect(revoke.status).toBe(200);
		expect(auth.service().resolveSession(second.token)).toBeNull();
		const current = await call(
			auth,
			'/api/auth/sessions/revoke',
			jsonRequest(
				'/api/auth/sessions/revoke',
				{ id: sessions.currentSessionId },
				authed(owner),
			),
		);
		expect(current.status).toBe(400);
	});
});
