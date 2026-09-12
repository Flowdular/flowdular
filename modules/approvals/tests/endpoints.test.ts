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

async function seed(accountId = REQUESTER, subjectRef = 'product-4711') {
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
		tenantId: TENANT,
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
				: await mutation(path, { id: 'x' });
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
		expect((await allowed.json()).requests).toHaveLength(1);
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
			(await listed.json()).requests.map((entry: { id: string }) => entry.id),
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
