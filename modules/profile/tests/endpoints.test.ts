import { createContext, type ServerRoute } from '@octanejs/app-core';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_PERMISSIONS } from '../src/acl/permissions.ts';
import { createProfileRoutes } from '../src/api/endpoints.ts';
import {
	createProfileRuntime,
	type ProfileRuntime,
} from '../src/server/runtime.ts';
import {
	closeProfileTestDatabases,
	profileTestProvider,
} from './support/database.ts';

const ORIGIN = 'https://flowdular.example';

describe('profile language endpoints', () => {
	let auth: AuthRuntime;
	let authDatabases: DatabaseProvider;
	let profile: ProfileRuntime;
	let routes: readonly ServerRoute[];

	/* auth.core owns its own cluster here: the profile fixture only truncates
	   profile tables, so a shared one would carry accounts between cases. */
	beforeEach(async () => {
		authDatabases = createPgliteTestProvider();
		auth = createAuthRuntime({
			databases: authDatabases,
			purpose: 'test',
			secureCookies: false,
			sessionTtlMs: 12 * 60 * 60 * 1000,
			sessionIdleMs: 2 * 60 * 60 * 1000,
			passwordMinLength: 12,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			locales: ['en', 'pl'],
		});
		profile = createProfileRuntime({
			databases: await profileTestProvider(),
			purpose: 'test',
		});
		routes = createProfileRoutes(auth, profile);
	});

	afterEach(async () => {
		await profile.dispose();
		await auth.dispose();
		await authDatabases.dispose();
	});

	afterAll(closeProfileTestDatabases);

	const call = async (request: Request): Promise<Response> => {
		const route = routes.find(
			(candidate) =>
				candidate.path === '/api/profile/language' &&
				candidate.methods.includes(request.method),
		);
		if (!route) throw new Error(`Missing ${request.method} language route.`);
		const context = createContext(request, {});
		return auth.middleware(context, () =>
			Promise.resolve(route.handler(context)),
		) as Promise<Response>;
	};

	const read = (cookie?: string): Request =>
		new Request(`${ORIGIN}/api/profile/language`, {
			headers: cookie ? { cookie } : {},
		});

	const update = (
		locale: string,
		cookie: string,
		csrfToken?: string,
	): Request =>
		new Request(`${ORIGIN}/api/profile/language`, {
			method: 'PUT',
			headers: {
				cookie,
				origin: ORIGIN,
				'content-type': 'application/json',
				...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
			},
			body: JSON.stringify({ locale }),
		});

	it('returns 401 without a session and 403 without the module permission', async () => {
		expect((await call(read())).status).toBe(401);
		expect((await call(update('pl', ''))).status).toBe(401);

		const issued = await (
			await auth.service()
		).signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		/* A founding owner holds profile.self.manage by default since auth.core
		   0.12.6, so the denial is proved with a principal that carries no
		   scopes at all, injected the way the auth middleware would. */
		const denied = async (request: Request): Promise<Response> => {
			const route = routes.find(
				(candidate) =>
					candidate.path === '/api/profile/language' &&
					candidate.methods.includes(request.method),
			);
			if (!route) throw new Error(`Missing ${request.method} language route.`);
			const context = createContext(request, {});
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, {
				...issued.principal,
				scopes: [],
			});
			return (await route.handler(context)) as Response;
		};
		const refusals = [
			await denied(read()),
			await denied(update('pl', '', issued.csrfToken)),
		];
		for (const refusal of refusals) {
			expect([
				refusal.status,
				((await refusal.json()) as { error: { code: string } }).error.code,
			]).toEqual([403, 'FORBIDDEN']);
		}
		await expect(
			(await profile.service()).readLanguage(
				issued.principal.tenantId,
				issued.principal.accountId,
			),
		).resolves.toBeNull();
	});

	it('requires CSRF and stores only the authenticated tenant and account', async () => {
		const issued = await (
			await auth.service()
		).signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		await (
			await auth.service()
		).grantMembershipScopes(
			issued.principal.accountId,
			issued.principal.tenantId,
			[PROFILE_PERMISSIONS.manageSelf],
		);
		const cookie = `${auth.cookie.name}=${issued.token}`;

		expect((await call(update('pl', cookie))).status).toBe(403);
		const saved = await call(update('pl', cookie, issued.csrfToken));
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			preference: {
				tenantId: issued.principal.tenantId,
				accountId: issued.principal.accountId,
				locale: 'pl',
			},
		});
		expect((await call(update('de', cookie, issued.csrfToken))).status).toBe(
			400,
		);

		await (
			await profile.service()
		).updateLanguage('tenant-b', issued.principal.accountId, { locale: 'en' });
		const response = await call(read(cookie));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ locale: 'pl' });
		await expect(
			(await profile.service()).readLanguage(
				'tenant-b',
				issued.principal.accountId,
			),
		).resolves.toBe('en');
	});
});
