import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
	type PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createServerComposition } from '../src/platform.ts';
import {
	closeSandboxTestDatabases,
	sandboxTestProvider,
} from './support/database.ts';

const ORIGIN = 'https://erp.example';

function principal(scopes: readonly string[]): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId: 'tenant-http',
		email: 'account-a@example.com',
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* Session resolution is stubbed; these tests observe the sandbox audit routes,
   not auth.core's session handling, which its own suite covers. */
function authRuntime(_session: AuthPrincipal | null): AuthRuntime {
	return {
		cookie: {
			name: 'coreloom_session_dev',
			secure: false,
			maxAgeSeconds: 3_600,
		},
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => [],
		middleware: (_context: unknown, next: () => Promise<Response>) => next(),
		service: () => ({}) as unknown as ReturnType<AuthRuntime['service']>,
	} as unknown as AuthRuntime;
}

const compositions = new Set<{ dispose?: () => Promise<void> | void }>();

afterEach(async () => {
	for (const composed of compositions) await composed.dispose?.();
	compositions.clear();
});

afterAll(closeSandboxTestDatabases);

/* Composition takes a provider, so the test supplies the same shape the
   platform does instead of a database path. */
async function composition(session: AuthPrincipal | null) {
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: authRuntime(session),
		databases: await sandboxTestProvider(),
	};
	const composed = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	compositions.add(composed);
	const call = (
		path: string,
		init: { readonly authenticated?: boolean } = {},
	) => {
		const { authenticated = true } = init;
		const request = new Request(ORIGIN + path, { headers: { origin: ORIGIN } });
		const routePath = path.split('?')[0]!;
		const route = composed.routes.find(
			(candidate) =>
				candidate.path === routePath && candidate.methods.includes('GET'),
		);
		if (!route) throw new Error(`Route GET ${routePath} is missing.`);
		const state = new Map<string, unknown>();
		if (authenticated && session) state.set(AUTH_PRINCIPAL_STATE_KEY, session);
		return route.handler({
			request,
			params: {},
			url: new URL(request.url),
			state,
		} as never);
	};
	return { call };
}

describe('sandbox audit HTTP boundary', () => {
	it('guards the audit read and verify endpoints by the sessions read scope', async () => {
		const anonymous = await composition(null);
		expect(
			(await anonymous.call('/api/sandbox/audit', { authenticated: false }))
				.status,
		).toBe(401);

		const forbidden = await composition(principal(['sandbox.access.use']));
		expect((await forbidden.call('/api/sandbox/audit')).status).toBe(403);
		expect((await forbidden.call('/api/sandbox/audit/verify')).status).toBe(
			403,
		);

		const reader = await composition(principal(['sandbox.sessions.read']));
		const list = await reader.call('/api/sandbox/audit');
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({ events: [], nextCursor: null });
		const verify = await reader.call('/api/sandbox/audit/verify');
		expect(verify.status).toBe(200);
		expect(await verify.json()).toEqual({ verified: true, brokenAt: null });
	});

	it('rejects a malformed audit cursor with a 400', async () => {
		const reader = await composition(principal(['sandbox.sessions.read']));
		const response = await reader.call(
			'/api/sandbox/audit?cursor=not-a-cursor',
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_CURSOR' },
		});
	});
});
