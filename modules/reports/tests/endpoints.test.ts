import { afterEach, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { REPORTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createReportsRoutes } from '../src/api/endpoints.ts';
import { createReportsRuntime } from '../src/server/runtime.ts';
import { fakeProvider, TEST_BUDGET, tile } from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const USAGE = 'metering.usage.read';

/** Every provider call this request reached, so a denial is proved by absence. */
let calls: { readonly key: string; readonly tenantId: string }[] = [];

afterEach(() => {
	calls = [];
});

function principal(
	scopes: readonly string[],
	accountId = 'account-ada',
	tenantId = TENANT,
): AuthPrincipal {
	return {
		accountId,
		tenantId,
		email: `${accountId}@example.com`,
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* The real authentication middleware publishes the principal and the session
   the CSRF guard reads, so these routes are exercised through the same state
   the platform gives them rather than a hand-placed principal. */
function authRuntime(
	sessions: ReadonlyMap<string, AuthPrincipal>,
): AuthRuntime {
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3_600,
	};
	const service = {
		resolveSession: async (token: string | null) => {
			const found = token === null ? undefined : sessions.get(token);
			return found
				? { principal: found, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null;
		},
		resolveApiToken: async () => null,
		listTenantMembers: async () => [],
	} as unknown as Awaited<ReturnType<AuthRuntime['service']>>;
	return {
		cookie,
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => [],
		middleware: createAuthenticationMiddleware(async () => service, cookie),
		service: async () => service,
	} as unknown as AuthRuntime;
}

function fixture(session: AuthPrincipal | null) {
	const runtime = createReportsRuntime({ budget: () => TEST_BUDGET });
	runtime.providers.register('metering.core', [
		fakeProvider({
			key: 'metering.usage',
			permission: USAGE,
			answer: { tiles: [tile('requests', 12)] },
			onCall: (input) =>
				calls.push({ key: 'metering.usage', tenantId: input.tenantId }),
		}),
	]);
	runtime.start();
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createReportsRoutes(auth, runtime);
	const invoke = async (
		requestPath: string,
		init: RequestInit & { readonly authenticated?: boolean } = {},
	) => {
		const { authenticated = true, ...requestInit } = init;
		const headers = new Headers(requestInit.headers);
		if (authenticated && session) {
			headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
		} else {
			headers.delete('cookie');
		}
		const request = new Request(ORIGIN + requestPath, {
			...requestInit,
			method: 'GET',
			headers,
		});
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return routes[0].handler(context as never);
	};
	return { invoke };
}

async function body(response: Response): Promise<Record<string, never>> {
	return (await response.json()) as Record<string, never>;
}

describe('REPORTS-DENY', () => {
	it('refuses an unauthenticated read before any provider runs', async () => {
		const response = await fixture(null).invoke('/api/reports', {
			authenticated: false,
		});
		expect(response.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it('refuses a member without reports.workspace.read before any provider runs', async () => {
		const response = await fixture(principal([USAGE])).invoke('/api/reports');
		expect(response.status).toBe(403);
		expect(calls).toEqual([]);
	});
});

describe('REPORTS-READ-CSRF-FREE', () => {
	it('answers a read that carries no CSRF token', async () => {
		const response = await fixture(
			principal([REPORTS_PERMISSIONS.read, USAGE]),
		).invoke('/api/reports');
		expect(response.status).toBe(200);
		const page = await body(response);
		expect(page.reports).toHaveLength(1);
		expect(page.unavailable).toEqual([]);
		expect(page.range).toBeTruthy();
	});
});

describe('REPORTS-RANGE endpoint', () => {
	it('refuses a reversed range with a stable code before any provider runs', async () => {
		const response = await fixture(
			principal([REPORTS_PERMISSIONS.read, USAGE]),
		).invoke('/api/reports?from=2026-09-12&to=2026-09-01');
		expect(response.status).toBe(400);
		expect((await body(response)).error).toMatchObject({
			code: 'INVALID_RANGE',
		});
		expect(calls).toEqual([]);
	});

	it('hands the provider exactly the range the request named', async () => {
		let observed: { from: string; to: string } | undefined;
		const runtime = createReportsRuntime({ budget: () => TEST_BUDGET });
		runtime.providers.register('metering.core', [
			fakeProvider({
				key: 'metering.usage',
				permission: USAGE,
				onCall: (input) => {
					observed = { ...input.range };
				},
			}),
		]);
		runtime.start();
		const session = principal([REPORTS_PERMISSIONS.read, USAGE]);
		const sessions = new Map([[SESSION_TOKEN, session]]);
		const auth = authRuntime(sessions);
		const routes = createReportsRoutes(auth, runtime);
		const request = new Request(
			ORIGIN + '/api/reports?from=2026-01-01&to=2026-01-31',
			{ headers: { cookie: `coreloom_session_dev=${SESSION_TOKEN}` } },
		);
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		await routes[0].handler(context as never);

		expect(observed).toEqual({ from: '2026-01-01', to: '2026-01-31' });
	});
});

describe('REPORTS-TENANT-BOUNDARY endpoint', () => {
	/* The tenant is the principal's and nothing else: a query parameter that
	   names another workspace changes nothing a provider is asked for. */
	it('ignores a tenant the request tries to name', async () => {
		const response = await fixture(
			principal([REPORTS_PERMISSIONS.read, USAGE]),
		).invoke('/api/reports?tenantId=tenant-other&tenant=tenant-other');
		expect(response.status).toBe(200);
		expect(calls).toEqual([{ key: 'metering.usage', tenantId: TENANT }]);
	});
});
