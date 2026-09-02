import { createContext, type ServerRoute } from '@octanejs/app-core';
import {
	createAuthRuntime,
	type AuthRuntime,
} from '@coreloom/module-auth/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_PERMISSIONS } from '../src/acl/permissions.ts';
import { createProfileRoutes } from '../src/api/endpoints.ts';
import {
	createProfileRuntime,
	type ProfileRuntime,
} from '../src/server/runtime.ts';

const ORIGIN = 'https://coreloom.example';

describe('profile language endpoints', () => {
	let auth: AuthRuntime;
	let profile: ProfileRuntime;
	let routes: readonly ServerRoute[];

	beforeEach(() => {
		auth = createAuthRuntime({
			databasePath: ':memory:',
			secureCookies: false,
			sessionTtlMs: 12 * 60 * 60 * 1000,
			sessionIdleMs: 2 * 60 * 60 * 1000,
			passwordMinLength: 12,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			locales: ['en', 'pl'],
		});
		profile = createProfileRuntime({ databasePath: ':memory:' });
		routes = createProfileRoutes(auth, profile);
	});

	afterEach(() => {
		profile.dispose();
		auth.dispose();
	});

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

		const issued = await auth.service().signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		const cookie = `${auth.cookie.name}=${issued.token}`;
		expect((await call(read(cookie))).status).toBe(403);
		expect((await call(update('pl', cookie, issued.csrfToken))).status).toBe(
			403,
		);
		expect(
			profile
				.service()
				.readLanguage(issued.principal.tenantId, issued.principal.accountId),
		).toBeNull();
	});

	it('requires CSRF and stores only the authenticated tenant and account', async () => {
		const issued = await auth.service().signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		auth
			.service()
			.grantMembershipScopes(
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

		profile
			.service()
			.updateLanguage('tenant-b', issued.principal.accountId, { locale: 'en' });
		const response = await call(read(cookie));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ locale: 'pl' });
		expect(
			profile.service().readLanguage('tenant-b', issued.principal.accountId),
		).toBe('en');
	});
});
