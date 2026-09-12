import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { SEARCH_PERMISSIONS } from '../src/acl/permissions.ts';
import { createSearchRoutes } from '../src/api/endpoints.ts';
import { createSearchRuntime } from '../src/server/runtime.ts';
import {
	openSearchTestDatabase,
	type SearchTestDatabase,
} from './support/database.ts';
import { fakeProvider, hit, TEST_BUDGET } from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const MEMBERS = 'users.members.read';

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

let shared: SearchTestDatabase;
/** Provider calls this request reached, so a denial can be proved by absence. */
let calls: string[] = [];

beforeAll(async () => {
	shared = await openSearchTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	calls = [];
	await shared.reset();
});

function fixture(session: AuthPrincipal | null) {
	const runtime = createSearchRuntime({
		databases: shared.databases,
		repository: shared.repository,
		budget: () => TEST_BUDGET,
	});
	runtime.providers.register('users.core', [
		fakeProvider({
			key: 'users.members',
			permission: MEMBERS,
			pages: [[hit('ada', 9)], [hit('alan', 4)]],
			onCall: (input) =>
				calls.push('users.members' + (input.cursor ? `@${input.cursor}` : '')),
		}),
	]);
	runtime.start();
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createSearchRoutes(auth, runtime);
	const route = (path: string, method: string) => {
		const found = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(method),
		);
		if (!found) throw new Error(`Route ${method} ${path} is missing.`);
		return found;
	};
	const invoke = async (
		path: string,
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
		const method = requestInit.method ?? 'GET';
		if (method !== 'GET') headers.set('origin', ORIGIN);
		const request = new Request(ORIGIN + requestPath, {
			...requestInit,
			method,
			headers,
		});
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		/* The real authentication middleware publishes the principal and the
		   session the CSRF guard reads, so a denial is proved through the same
		   state the platform gives these routes. */
		await auth.middleware(context as never, async () => new Response(null));
		return route(path, method).handler(context as never);
	};
	return { invoke, dispose: () => runtime.dispose() };
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('SEARCH-DENY', () => {
	it('refuses an unauthenticated search before any provider runs', async () => {
		const harness = fixture(null);
		try {
			const response = await harness.invoke(
				'/api/search',
				'/api/search?q=ada',
				{
					authenticated: false,
				},
			);
			expect(response.status).toBe(401);
			expect(calls).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a member without search.records.read before any provider runs', async () => {
		const harness = fixture(principal([MEMBERS]));
		try {
			const response = await harness.invoke('/api/search', '/api/search?q=ada');
			expect(response.status).toBe(403);
			expect(calls).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a recent list and a clear without the permission', async () => {
		const harness = fixture(principal([MEMBERS]));
		try {
			expect(
				(await harness.invoke('/api/search/recent', '/api/search/recent'))
					.status,
			).toBe(403);
			expect(
				(
					await harness.invoke(
						'/api/search/recent/clear',
						'/api/search/recent/clear',
						{
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								'x-csrf-token': CSRF_TOKEN,
							},
							body: '{}',
						},
					)
				).status,
			).toBe(403);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a recall write without the permission', async () => {
		const harness = fixture(principal([MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search/recent',
				'/api/search/recent',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': CSRF_TOKEN,
					},
					body: JSON.stringify({ q: 'ada' }),
				},
			);
			expect(response.status).toBe(403);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a recall write without the CSRF token', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read]));
		try {
			const response = await harness.invoke(
				'/api/search/recent',
				'/api/search/recent',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ q: 'ada' }),
				},
			);
			expect(response.status).toBe(403);
			expect((await body(response)).error).toMatchObject({
				code: 'CSRF_REJECTED',
			});
			expect(
				(
					await body(
						await harness.invoke('/api/search/recent', '/api/search/recent'),
					)
				).items,
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a clear without the CSRF token', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read]));
		try {
			const response = await harness.invoke(
				'/api/search/recent/clear',
				'/api/search/recent/clear',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				},
			);
			expect(response.status).toBe(403);
			expect((await body(response)).error).toMatchObject({
				code: 'CSRF_REJECTED',
			});
		} finally {
			await harness.dispose();
		}
	});
});

describe('search endpoints', () => {
	it('answers hits, the provider list and the page shape', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke('/api/search', '/api/search?q=ada');
			expect(response.status).toBe(200);
			const payload = await body(response);
			expect(payload.items).toHaveLength(1);
			expect(payload.page).toMatchObject({ nextCursor: null });
			expect(payload.providers).toHaveLength(1);
			expect(payload.unavailable).toEqual([]);
			expect(calls).toEqual(['users.members']);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses an over-long query with a stable code and calls nobody', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search',
				'/api/search?q=' + 'a'.repeat(201),
			);
			expect(response.status).toBe(400);
			expect((await body(response)).error).toMatchObject({
				code: 'QUERY_TOO_LONG',
			});
			expect(calls).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a cursor this server did not sign', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search',
				'/api/search?q=ada&cursor=c1.forged.signature',
			);
			expect(response.status).toBe(400);
			expect((await body(response)).error).toMatchObject({
				code: 'CURSOR_INVALID',
			});
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a limit over the endpoint bound', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search',
				'/api/search?q=ada&limit=500',
			);
			expect(response.status).toBe(400);
			expect((await body(response)).error).toMatchObject({
				code: 'INVALID_INPUT',
			});
		} finally {
			await harness.dispose();
		}
	});

	/* SEARCH-PAGING over HTTP: the cursor the response carries is signed by this
	   server, and sending it back is what the load-more control does. */
	it('answers a cursor and resumes the provider when it is sent back', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const first = await body(
				await harness.invoke('/api/search', '/api/search?q=ada&limit=1'),
			);
			expect(
				(first.items as { ref: string }[]).map((item) => item.ref),
			).toEqual(['ada']);
			const cursor = (first.page as { nextCursor: string | null }).nextCursor;
			expect(typeof cursor).toBe('string');

			const second = await body(
				await harness.invoke(
					'/api/search',
					'/api/search?q=ada&limit=1&cursor=' +
						encodeURIComponent(cursor as string),
				),
			);

			expect(
				(second.items as { ref: string }[]).map((item) => item.ref),
			).toEqual(['alan']);
			expect((second.page as { nextCursor: string | null }).nextCursor).toBe(
				null,
			);
			expect(calls).toEqual(['users.members', 'users.members@1']);
		} finally {
			await harness.dispose();
		}
	});

	/* SEARCH-RECENT-DELIBERATE: the screen searches on every debounced
	   keystroke, so recall is asked for by the request, not by the endpoint. */
	it('keeps only the query that asked to be remembered', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			await harness.invoke('/api/search', '/api/search?q=ad');
			await harness.invoke('/api/search', '/api/search?q=ada&remember=1');

			const listed = await body(
				await harness.invoke('/api/search/recent', '/api/search/recent'),
			);

			expect(
				(listed.items as { query: string }[]).map((row) => row.query),
			).toEqual(['ada']);
		} finally {
			await harness.dispose();
		}
	});

	/* SEARCH-OPEN-RECALL: the screen navigates away as the member opens a hit,
	   so the recall write is its own request and calls no provider. */
	it('SEARCH-OPEN-RECALL keeps an opened query without searching again', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			await harness.invoke('/api/search', '/api/search?q=ada');
			calls = [];

			const response = await harness.invoke(
				'/api/search/recent',
				'/api/search/recent',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': CSRF_TOKEN,
					},
					body: JSON.stringify({ q: 'ada' }),
				},
			);

			expect(response.status).toBe(200);
			expect(await body(response)).toEqual({ recorded: true });
			expect(calls).toEqual([]);
			expect(
				(
					(
						await body(
							await harness.invoke('/api/search/recent', '/api/search/recent'),
						)
					).items as { query: string }[]
				).map((row) => row.query),
			).toEqual(['ada']);
		} finally {
			await harness.dispose();
		}
	});

	it('SEARCH-OPEN-RECALL keeps nothing for a term under the minimum', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search/recent',
				'/api/search/recent',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': CSRF_TOKEN,
					},
					body: JSON.stringify({ q: 'a' }),
				},
			);

			expect(await body(response)).toEqual({ recorded: false });
			expect(
				(
					await body(
						await harness.invoke('/api/search/recent', '/api/search/recent'),
					)
				).items,
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('refuses an over-long query on the recall write', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			const response = await harness.invoke(
				'/api/search/recent',
				'/api/search/recent',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': CSRF_TOKEN,
					},
					body: JSON.stringify({ q: 'a'.repeat(201) }),
				},
			);

			expect(response.status).toBe(400);
			expect((await body(response)).error).toMatchObject({
				code: 'QUERY_TOO_LONG',
			});
		} finally {
			await harness.dispose();
		}
	});

	it('lists and clears the member own recent queries', async () => {
		const harness = fixture(principal([SEARCH_PERMISSIONS.read, MEMBERS]));
		try {
			await harness.invoke('/api/search', '/api/search?q=ada&remember=1');
			const listed = await body(
				await harness.invoke('/api/search/recent', '/api/search/recent'),
			);
			expect(listed.items).toHaveLength(1);

			const cleared = await body(
				await harness.invoke(
					'/api/search/recent/clear',
					'/api/search/recent/clear',
					{
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-csrf-token': CSRF_TOKEN,
						},
						body: '{}',
					},
				),
			);
			expect(cleared).toEqual({ cleared: 1 });
			expect(
				(
					await body(
						await harness.invoke('/api/search/recent', '/api/search/recent'),
					)
				).items,
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});
});
