import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { APPROVALS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createApprovalsRoutes } from '../src/api/endpoints.ts';
import { createApprovalsRuntime } from '../src/server/runtime.ts';
import type { ApprovalMember } from '../src/domain/types.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import { member, OWNER_ROLE } from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const REQUESTER = 'account-requester';
const ALL_SCOPES = Object.values(APPROVALS_PERMISSIONS);

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
		role: OWNER_ROLE,
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

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

const MEMBERS: ApprovalMember[] = [
	member(REQUESTER, OWNER_ROLE),
	member('account-ada', OWNER_ROLE),
	member('account-bo', OWNER_ROLE),
];

function fixture(session: AuthPrincipal | null) {
	const runtime = createApprovalsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		members: async () => MEMBERS,
		member: async (_tenantId, accountId) =>
			MEMBERS.find((entry) => entry.accountId === accountId) ?? null,
		defaultExpiryDays: () => 7,
		expiryIntervalMs: () => 60_000,
	});
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createApprovalsRoutes(auth, runtime);
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
		init: RequestInit & {
			readonly authenticated?: boolean;
			readonly params?: Record<string, string>;
		} = {},
	) => {
		const { authenticated = true, params = {}, ...requestInit } = init;
		const headers = new Headers(requestInit.headers);
		if (authenticated && session) {
			headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
		} else {
			headers.delete('cookie');
		}
		const request = new Request(ORIGIN + requestPath, {
			...requestInit,
			headers,
		});
		const context = {
			request,
			params,
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route(path, requestInit.method ?? 'GET').handler(context as never);
	};
	const call = (path: string, init: Parameters<typeof invoke>[2] = {}) =>
		invoke(path.split('?')[0]!, path, init);
	const mutation = (
		path: string,
		body: unknown,
		init: Parameters<typeof invoke>[2] = {},
	) =>
		call(path, {
			...init,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
				...(init.headers as Record<string, string> | undefined),
			},
			body: JSON.stringify(body),
		});
	return { call, mutation, invoke, runtime };
}

async function seed(
	accountId = REQUESTER,
	subjectRef = 'product-4711',
	tenantId = TENANT,
) {
	const runtime = createApprovalsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		members: async () => MEMBERS,
		member: async (_tenantId, accountId) =>
			MEMBERS.find((entry) => entry.accountId === accountId) ?? null,
		defaultExpiryDays: () => 7,
		expiryIntervalMs: () => 60_000,
	});
	return (await runtime.service()).open({
		tenantId,
		subjectModule: 'catalog.core',
		subjectRef,
		permission: 'catalog.products.manage',
		action: 'publish',
		title: 'Publish product 4711',
		requesterAccountId: accountId,
		requirement: { roleKey: OWNER_ROLE },
	});
}

const READ_PATHS = [
	['/api/approvals/requests', APPROVALS_PERMISSIONS.read],
	['/api/approvals/pending-count', APPROVALS_PERMISSIONS.read],
] as const;

const MUTATION_PATHS = [
	['/api/approvals/requests/approve', APPROVALS_PERMISSIONS.decide],
	['/api/approvals/requests/reject', APPROVALS_PERMISSIONS.decide],
	['/api/approvals/decide-many', APPROVALS_PERMISSIONS.decide],
	['/api/approvals/requests/cancel', APPROVALS_PERMISSIONS.read],
] as const;

describe('APPROVALS-DENY', () => {
	it('APPROVALS-DENY answers 401 without a session on every route', async () => {
		const { call, mutation } = fixture(principal(ALL_SCOPES));
		for (const [path] of READ_PATHS) {
			const response = await call(path, { authenticated: false });
			expect([path, response.status]).toEqual([path, 401]);
		}
		for (const [path] of MUTATION_PATHS) {
			const response = await mutation(
				path,
				{ id: 'x' },
				{
					authenticated: false,
				},
			);
			expect([path, response.status]).toEqual([path, 401]);
		}
	});

	it('APPROVALS-DENY answers 403 without the permission the route declares', async () => {
		for (const [path, permission] of [...READ_PATHS, ...MUTATION_PATHS]) {
			const scopes = ALL_SCOPES.filter((scope) => scope !== permission);
			const { call, mutation } = fixture(principal(scopes));
			const response = READ_PATHS.some((entry) => entry[0] === path)
				? await call(path)
				: await mutation(path, { id: 'x', ids: ['x'], decision: 'approve' });
			expect([path, response.status]).toEqual([path, 403]);
		}
	});

	it('APPROVALS-DENY refuses a mutation without a CSRF proof before it reads the body', async () => {
		const request = await seed();
		const { mutation } = fixture(principal(ALL_SCOPES));
		const response = await mutation(
			'/api/approvals/requests/approve',
			{ id: request.id },
			{ headers: { 'x-csrf-token': 'wrong' } },
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe('CSRF_REJECTED');
	});

	it('APPROVALS-DENY keeps every request of the workspace behind the manage permission', async () => {
		await seed('account-bo');
		const { call } = fixture(
			principal([APPROVALS_PERMISSIONS.read, APPROVALS_PERMISSIONS.decide]),
		);
		const denied = await call('/api/approvals/requests?scope=all');
		expect(denied.status).toBe(403);

		const { call: managed } = fixture(principal(ALL_SCOPES));
		const allowed = await managed('/api/approvals/requests?scope=all');
		expect(allowed.status).toBe(200);
		expect((await allowed.json()).items).toHaveLength(1);
	});

	it('APPROVALS-DENY hides a request from a member who neither asked nor may decide', async () => {
		const request = await seed('account-bo');
		const { invoke } = fixture(
			principal(
				[APPROVALS_PERMISSIONS.read, APPROVALS_PERMISSIONS.decide],
				'account-outsider',
			),
		);
		const response = await invoke(
			'/api/approvals/requests/:id',
			`/api/approvals/requests/${request.id}`,
			{ params: { id: request.id } },
		);
		expect(response.status).toBe(404);
	});

	it('APPROVALS-DENY hides a request from a member who decides or cancels it without reading it', async () => {
		const request = await seed('account-bo');
		const { mutation } = fixture(
			principal(
				[APPROVALS_PERMISSIONS.read, APPROVALS_PERMISSIONS.decide],
				'account-outsider',
			),
		);
		/* A 404 on the read and a 409 on the decision would still tell this
		   member that the request exists and what became of it. */
		for (const path of [
			'/api/approvals/requests/approve',
			'/api/approvals/requests/reject',
			'/api/approvals/requests/cancel',
		]) {
			const response = await mutation(path, { id: request.id });
			expect([path, response.status]).toEqual([path, 404]);
			expect([path, (await response.json()).error.code]).toEqual([
				path,
				'APPROVAL_NOT_FOUND',
			]);
		}
	});

	it('APPROVALS-DENY refuses an unknown status filter instead of ignoring it', async () => {
		const { call } = fixture(principal(ALL_SCOPES));
		const response = await call('/api/approvals/requests?status=unknown');
		expect(response.status).toBe(400);
	});
});

describe('approvals endpoints', () => {
	it('lists what the member may decide, counts it and records a decision', async () => {
		const request = await seed();
		const { call, mutation, invoke } = fixture(principal(ALL_SCOPES));

		const listed = await call('/api/approvals/requests');
		expect(listed.status).toBe(200);
		expect(
			(await listed.json()).items.map((entry: { id: string }) => entry.id),
		).toEqual([request.id]);

		const counted = await call('/api/approvals/pending-count');
		expect((await counted.json()).pending).toBe(1);

		const opened = await invoke(
			'/api/approvals/requests/:id',
			`/api/approvals/requests/${request.id}`,
			{ params: { id: request.id } },
		);
		expect(opened.status).toBe(200);
		const detail = await opened.json();
		expect(detail.viewer).toEqual({
			accountId: 'account-ada',
			canDecide: true,
			canCancel: true,
		});

		const approved = await mutation('/api/approvals/requests/approve', {
			id: request.id,
			comment: 'Fine.',
		});
		expect(approved.status).toBe(200);
		const body = await approved.json();
		expect(body.request.status).toBe('approved');
		expect(body.viewer.canDecide).toBe(false);

		const after = await call('/api/approvals/pending-count');
		expect((await after.json()).pending).toBe(0);
	});

	it('lets the requester cancel without the manage permission', async () => {
		const request = await seed();
		const { mutation } = fixture(
			principal([APPROVALS_PERMISSIONS.read], REQUESTER),
		);
		const response = await mutation('/api/approvals/requests/cancel', {
			id: request.id,
		});
		expect(response.status).toBe(200);
		expect((await response.json()).request.status).toBe('cancelled');
	});

	it('refuses a decision by the requester with a stable code', async () => {
		const request = await seed();
		const { mutation } = fixture(principal(ALL_SCOPES, REQUESTER));
		const response = await mutation('/api/approvals/requests/approve', {
			id: request.id,
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe('APPROVAL_NOT_ELIGIBLE');
	});
});

interface ListBody {
	readonly items: readonly { readonly id: string }[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

async function listPage(
	call: ReturnType<typeof fixture>['call'],
	search: string,
): Promise<ListBody> {
	const response = await call('/api/approvals/requests' + search);
	expect([search, response.status]).toEqual([search, 200]);
	return (await response.json()) as ListBody;
}

async function refused(
	call: ReturnType<typeof fixture>['call'],
	search: string,
	code: string,
): Promise<void> {
	const response = await call('/api/approvals/requests' + search);
	expect([search, response.status]).toEqual([search, 400]);
	expect([search, (await response.json()).error.code]).toEqual([search, code]);
}

describe('APPROVALS-INBOX-PAGE', () => {
	it('APPROVALS-INBOX-PAGE walks consecutive pages with no overlap and no gap, in both directions', async () => {
		for (const index of [1, 2, 3, 4, 5])
			await seed(REQUESTER, `product-${index}`);
		const { call } = fixture(principal(ALL_SCOPES));
		const whole = (await listPage(call, '?limit=10')).items.map(
			(entry) => entry.id,
		);
		expect(whole).toHaveLength(5);

		const first = await listPage(call, '?limit=2');
		expect(first.items).toHaveLength(2);
		expect(first.page.nextCursor).not.toBeNull();
		const second = await listPage(
			call,
			`?limit=2&cursor=${first.page.nextCursor}`,
		);
		expect(second.items).toHaveLength(2);
		expect(second.page.nextCursor).not.toBeNull();
		const third = await listPage(
			call,
			`?limit=2&cursor=${second.page.nextCursor}`,
		);
		expect(third.items).toHaveLength(1);
		expect(third.page.nextCursor).toBeNull();
		expect(
			[...first.items, ...second.items, ...third.items].map(
				(entry) => entry.id,
			),
		).toEqual(whole);

		const ascending = await listPage(call, '?limit=3&direction=asc');
		const ascendingRest = await listPage(
			call,
			`?limit=3&direction=asc&cursor=${ascending.page.nextCursor}`,
		);
		expect(
			[...ascending.items, ...ascendingRest.items].map((entry) => entry.id),
		).toEqual([...whole].reverse());
	});

	it('APPROVALS-INBOX-PAGE answers a cursor for a full page only, and none past the end', async () => {
		await seed(REQUESTER, 'product-1');
		await seed(REQUESTER, 'product-2');
		const { call } = fixture(principal(ALL_SCOPES));
		const full = await listPage(call, '?limit=2');
		expect(full.items).toHaveLength(2);
		expect(full.page.nextCursor).not.toBeNull();
		const past = await listPage(
			call,
			`?limit=2&cursor=${full.page.nextCursor}`,
		);
		expect(past.items).toHaveLength(0);
		expect(past.page.nextCursor).toBeNull();

		const short = await listPage(call, '?limit=3');
		expect(short.items).toHaveLength(2);
		expect(short.page.nextCursor).toBeNull();
	});

	it('APPROVALS-INBOX-PAGE refuses a tampered, foreign-tenant or re-scoped cursor', async () => {
		await seed(REQUESTER, 'product-1');
		await seed(REQUESTER, 'product-2');
		const { call } = fixture(principal(ALL_SCOPES));
		const cursor = (await listPage(call, '?limit=1&status=pending')).page
			.nextCursor!;
		const [version, body, signature] = cursor.split('.');
		const edited = `${version}.${body!.slice(0, -2)}AA.${signature}`;
		await refused(
			call,
			`?limit=1&status=pending&cursor=${edited}`,
			'CURSOR_INVALID',
		);
		await refused(call, '?cursor=c1.not.signed', 'CURSOR_INVALID');

		const { call: foreign } = fixture(
			principal(ALL_SCOPES, 'account-ada', 'tenant-other'),
		);
		await refused(
			foreign,
			`?limit=1&status=pending&cursor=${cursor}`,
			'CURSOR_INVALID',
		);

		/* The same cursor under another filter, sort or scope names a page of a
		   different list. */
		await refused(call, `?limit=1&cursor=${cursor}`, 'CURSOR_INVALID');
		await refused(
			call,
			`?limit=1&status=pending&direction=asc&cursor=${cursor}`,
			'CURSOR_INVALID',
		);
		await refused(
			call,
			`?limit=1&status=pending&scope=mine&cursor=${cursor}`,
			'CURSOR_INVALID',
		);
		const same = await listPage(
			call,
			`?limit=1&status=pending&cursor=${cursor}`,
		);
		expect(same.items).toHaveLength(1);
	});

	it('APPROVALS-INBOX-PAGE refuses an unknown sort, direction or limit', async () => {
		const { call } = fixture(principal(ALL_SCOPES));
		await refused(call, '?sort=title', 'INVALID_INPUT');
		await refused(call, '?direction=down', 'INVALID_INPUT');
		await refused(call, '?limit=0', 'INVALID_INPUT');
		await refused(call, '?limit=201', 'INVALID_INPUT');
		const bounded = await listPage(
			call,
			'?limit=200&sort=createdAt&direction=desc',
		);
		expect(bounded.page.limit).toBe(200);
	});
});

describe('APPROVALS-DECIDE-MANY', () => {
	it('APPROVALS-DECIDE-MANY refuses an unbounded, repeated or unknown decision before any row is touched', async () => {
		const request = await seed();
		const { mutation, invoke } = fixture(principal(ALL_SCOPES));
		const refusals: { readonly ids?: unknown; readonly decision?: unknown }[] =
			[
				{ ids: [], decision: 'approve' },
				{ ids: 'x', decision: 'approve' },
				{
					ids: Array.from({ length: 101 }, (_, index) => `r-${index}`),
					decision: 'approve',
				},
				{ ids: [request.id, request.id], decision: 'approve' },
				{ ids: [request.id], decision: 'cancel' },
				{ ids: [request.id] },
			];
		for (const body of refusals) {
			const response = await mutation('/api/approvals/decide-many', body);
			expect([JSON.stringify(body).slice(0, 40), response.status]).toEqual([
				JSON.stringify(body).slice(0, 40),
				400,
			]);
			expect((await response.json()).error.code).toBe('INVALID_INPUT');
		}
		const untouched = await invoke(
			'/api/approvals/requests/:id',
			`/api/approvals/requests/${request.id}`,
			{ params: { id: request.id } },
		);
		expect((await untouched.json()).request.status).toBe('pending');
	});

	it('APPROVALS-DECIDE-MANY refuses a call without the CSRF proof before it reads the body', async () => {
		const request = await seed();
		const { mutation } = fixture(principal(ALL_SCOPES));
		const response = await mutation(
			'/api/approvals/decide-many',
			{ ids: [request.id], decision: 'approve' },
			{ headers: { 'x-csrf-token': 'wrong' } },
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe('CSRF_REJECTED');
	});

	it('APPROVALS-DECIDE-MANY answers one outcome per id, records a decision per decided row and runs each callback', async () => {
		const { mutation, invoke, runtime } = fixture(principal(ALL_SCOPES));
		const resolved: string[] = [];
		const service = await runtime.service();
		const open = (subjectRef: string) =>
			service.open({
				tenantId: TENANT,
				subjectModule: 'catalog.core',
				subjectRef,
				permission: 'catalog.products.manage',
				action: 'publish',
				title: `Publish ${subjectRef}`,
				requesterAccountId: REQUESTER,
				requirement: { roleKey: OWNER_ROLE },
				onResolved: async (request) => {
					resolved.push(request.id);
				},
			});
		const first = await open('product-1');
		const second = await open('product-2');
		const done = await seed(REQUESTER, 'product-3');
		const foreign = await seed(REQUESTER, 'product-4', 'tenant-other');
		const earlier = await mutation('/api/approvals/requests/approve', {
			id: done.id,
		});
		expect(earlier.status).toBe(200);

		const response = await mutation('/api/approvals/decide-many', {
			ids: [first.id, 'missing', foreign.id, done.id, second.id],
			decision: 'reject',
			comment: 'Not this quarter.',
		});
		expect(response.status).toBe(200);
		expect((await response.json()).outcomes).toEqual([
			{ id: first.id, outcome: 'decided' },
			{ id: 'missing', outcome: 'not-found' },
			{ id: foreign.id, outcome: 'not-found' },
			{ id: done.id, outcome: 'refused', reason: 'APPROVAL_NOT_PENDING' },
			{ id: second.id, outcome: 'decided' },
		]);
		expect(resolved.sort()).toEqual([first.id, second.id].sort());

		for (const id of [first.id, second.id]) {
			const detail = await invoke(
				'/api/approvals/requests/:id',
				`/api/approvals/requests/${id}`,
				{ params: { id } },
			);
			const body = await detail.json();
			expect([id, body.request.status]).toEqual([id, 'rejected']);
			expect(body.decisions).toHaveLength(1);
			expect(body.decisions[0]).toMatchObject({
				deciderAccountId: 'account-ada',
				decision: 'reject',
				comment: 'Not this quarter.',
			});
		}
		/* The foreign request was answered not-found and left as it was. */
		expect(
			(await (await runtime.service()).get('tenant-other', foreign.id))?.status,
		).toBe('pending');
	});

	it('APPROVALS-DECIDE-MANY answers the requester and an ineligible member per id instead of failing the call', async () => {
		const own = await seed(REQUESTER, 'product-1');
		const other = await seed('account-bo', 'product-2');
		const { mutation } = fixture(principal(ALL_SCOPES, REQUESTER));
		const response = await mutation('/api/approvals/decide-many', {
			ids: [own.id, other.id],
			decision: 'approve',
		});
		expect(response.status).toBe(200);
		expect((await response.json()).outcomes).toEqual([
			{ id: own.id, outcome: 'refused', reason: 'APPROVAL_NOT_ELIGIBLE' },
			{ id: other.id, outcome: 'decided' },
		]);
	});
});
