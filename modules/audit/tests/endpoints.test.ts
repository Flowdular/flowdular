import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import type { DatabaseHandle } from '@flowdular/database';
import { AUDIT_PERMISSIONS } from '../src/acl/permissions.ts';
import { createAuditRoutes } from '../src/api/endpoints.ts';
import { createAuditRuntime } from '../src/server/runtime.ts';
import { DatabaseAuditRepository } from '../src/services/database-repository.ts';
import type { AuditRepository } from '../src/services/repository.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { FakeOwnerModule } from './support/fake-modules.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const ALL_SCOPES = Object.values(AUDIT_PERMISSIONS);

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

let shared: AuditTestDatabase;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function fixture(
	session: AuthPrincipal | null,
	repository: AuditRepository = shared.repository,
) {
	const dataClasses = createDataClassRegistry();
	const owner = new FakeOwnerModule('agents.core', 'runs');
	dataClasses.declare(owner.moduleId, [owner.declaration()]);
	const runtime = createAuditRuntime({
		databases: shared.databases,
		dataClasses,
		repository,
		sweepIntervalMs: () => 60_000,
		sweepBatchSize: () => 500,
	});
	dataClasses.seal();
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createAuditRoutes(auth, runtime);
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
		const request = new Request(ORIGIN + requestPath, {
			...requestInit,
			headers,
		});
		const context = {
			request,
			params: {},
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
	return { call, mutation, runtime, owner };
}

const READ_PATHS = [
	'/api/audit/data-classes',
	'/api/audit/sweeps',
	'/api/audit/exports',
	'/api/audit/holds',
] as const;

/* What a principal holding audit.registry.read alone may reach. The holds list
   names the account a hold covers and the matter behind it, so it is not one
   of them. */
const REGISTRY_READ_PATHS = [
	'/api/audit/data-classes',
	'/api/audit/sweeps',
	'/api/audit/exports',
] as const;

const HOLD_MUTATIONS = [
	['/api/audit/holds/place', { scopeKind: 'workspace', reason: 'Matter.' }],
	['/api/audit/holds/lift', { id: 'hold-1', reason: 'Closed.' }],
] as const;

describe('AUDIT-DENY', () => {
	it('answers 401 on every endpoint without an identity', async () => {
		const { call, mutation } = fixture(null);

		for (const path of READ_PATHS) {
			const response = await call(path, { authenticated: false });
			expect([path, response.status]).toEqual([path, 401]);
		}
		const response = await mutation(
			'/api/audit/data-classes/set-retention',
			{ classId: 'agents.core.runs', mode: 'none' },
			{ authenticated: false },
		);
		expect(response.status).toBe(401);
	});

	it('answers 403 on every endpoint without the permission', async () => {
		const { call, mutation } = fixture(principal([]));

		for (const path of READ_PATHS) {
			const response = await call(path);
			expect([path, response.status]).toEqual([path, 403]);
		}
		const response = await mutation('/api/audit/data-classes/set-retention', {
			classId: 'agents.core.runs',
			mode: 'none',
		});
		expect(response.status).toBe(403);
	});

	/* A member holding only the read permission must not be able to change a
	   period, which is the split the specification asks for. */
	it('refuses a period change from a principal holding only the read permission', async () => {
		const { mutation } = fixture(principal([AUDIT_PERMISSIONS.read]));

		const response = await mutation('/api/audit/data-classes/set-retention', {
			classId: 'agents.core.runs',
			mode: 'none',
		});

		expect(response.status).toBe(403);
	});

	it('refuses a mutation without a CSRF proof before it reaches the repository', async () => {
		const { mutation } = fixture(principal(ALL_SCOPES));

		const response = await mutation(
			'/api/audit/data-classes/set-retention',
			{ classId: 'agents.core.runs', mode: 'none' },
			{ headers: { 'x-csrf-token': 'wrong-token' } },
		);

		expect(response.status).toBe(403);
		expect(await shared.repository.listDataClasses(TENANT)).toEqual([]);
	});

	it('refuses a mutation that is not same origin', async () => {
		const { mutation } = fixture(principal(ALL_SCOPES));

		const response = await mutation(
			'/api/audit/data-classes/set-retention',
			{ classId: 'agents.core.runs', mode: 'none' },
			{ headers: { origin: 'https://evil.example' } },
		);

		expect(response.status).toBe(403);
	});

	it('serves the registry and accepts a period change with both permissions', async () => {
		const { call, mutation } = fixture(principal(ALL_SCOPES));

		const listed = await call('/api/audit/data-classes');
		expect(listed.status).toBe(200);
		expect(
			(
				(await listed.json()) as {
					modules: { moduleId: string; classes: unknown[] }[];
				}
			).modules.map((entry) => entry.moduleId),
			/* Composition order: this fixture declares the owner module before it
			   composes audit.core, the way the platform composes them. */
		).toEqual(['agents.core', 'audit.core']);

		const saved = await mutation('/api/audit/data-classes/set-retention', {
			classId: 'agents.core.runs',
			mode: 'days',
			days: 30,
		});
		expect(saved.status).toBe(200);
	});

	it('answers 401 and 403 on every hold mutation', async () => {
		for (const [path, body] of HOLD_MUTATIONS) {
			const anonymous = fixture(null);
			expect([
				path,
				(await anonymous.mutation(path, body, { authenticated: false })).status,
			]).toEqual([path, 401]);
			/* The read permission is not enough: only audit.holds.manage places
			   or lifts a hold. */
			const reader = fixture(principal([AUDIT_PERMISSIONS.read]));
			expect([path, (await reader.mutation(path, body)).status]).toEqual([
				path,
				403,
			]);
		}
	});

	it('refuses a hold mutation without a CSRF proof before it reaches the repository', async () => {
		const { mutation } = fixture(principal(ALL_SCOPES));

		const response = await mutation(
			'/api/audit/holds/place',
			{ scopeKind: 'workspace', reason: 'Matter.' },
			{ headers: { 'x-csrf-token': 'wrong-token' } },
		);

		expect(response.status).toBe(403);
		expect(await shared.repository.listHolds(TENANT, undefined, 10)).toEqual(
			[],
		);
	});

	it('places and lifts a hold with the manage permission', async () => {
		const { call, mutation } = fixture(principal(ALL_SCOPES));

		const placed = await mutation('/api/audit/holds/place', {
			scopeKind: 'account',
			accountId: 'account-bob',
			reason: 'Pending litigation.',
		});
		expect(placed.status).toBe(200);
		const hold = (
			(await placed.json()) as { hold: { id: string; status: string } }
		).hold;
		expect(hold.status).toBe('active');

		const lifted = await mutation('/api/audit/holds/lift', {
			id: hold.id,
			reason: 'Matter closed.',
		});
		expect(lifted.status).toBe(200);

		const listed = await call('/api/audit/holds?status=lifted');
		expect(listed.status).toBe(200);
		expect(
			((await listed.json()) as { holds: { id: string }[] }).holds.map(
				(entry) => entry.id,
			),
		).toEqual([hold.id]);
	});

	it('refuses a hold whose scope the kind does not carry', async () => {
		const { mutation } = fixture(principal(ALL_SCOPES));

		const response = await mutation('/api/audit/holds/place', {
			scopeKind: 'account',
			reason: 'No account named.',
		});

		expect(response.status).toBe(400);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe('HOLD_SCOPE_INVALID');
	});

	/* AUDIT-DENY-HOLDS: a hold names an account and the matter behind it, so
	   reading the registry is not enough to list one. */
	it('refuses the holds list to a principal holding only the read permission', async () => {
		const { call } = fixture(principal([AUDIT_PERMISSIONS.read]));

		const denied = await call('/api/audit/holds');

		expect(denied.status).toBe(403);
		for (const path of REGISTRY_READ_PATHS) {
			expect([path, (await call(path)).status]).toEqual([path, 200]);
		}
	});

	it('serves the holds list to a principal holding audit.holds.manage', async () => {
		const { call } = fixture(principal([AUDIT_PERMISSIONS.holdsManage]));

		const response = await call('/api/audit/holds');

		expect(response.status).toBe(200);
		expect(((await response.json()) as { holds: unknown[] }).holds).toEqual([]);
	});

	it('refuses an unknown filter value rather than ignoring it', async () => {
		const { call } = fixture(principal(ALL_SCOPES));

		const response = await call('/api/audit/sweeps?status=made-up');

		expect(response.status).toBe(400);
	});
});

/* A GET is a read. The registry screen refreshed the workspace's catalogue rows
   on every read, so the endpoint behind it opened a write transaction per
   request; the rows are written when a workspace has none or a composition
   changed the declarations, and never again. */
describe('AUDIT-REGISTRY-READ-ONLY', () => {
	function countingRepository(): {
		readonly repository: AuditRepository;
		readonly writes: () => number;
		reset(): void;
	} {
		let writes = 0;
		const counting = new Proxy(shared.runtime, {
			get(target, property) {
				if (property === 'transaction') {
					return async (
						operation: Parameters<DatabaseHandle['transaction']>[0],
						options?: Parameters<DatabaseHandle['transaction']>[1],
					) => {
						if (options?.access === 'write') writes += 1;
						return target.transaction(operation, options);
					};
				}
				const value = Reflect.get(target, property) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		return {
			repository: new DatabaseAuditRepository({
				runtime: counting,
				background: shared.background,
			}),
			writes: () => writes,
			reset: () => {
				writes = 0;
			},
		};
	}

	it('writes the catalogue of a workspace that has none and reads it afterwards', async () => {
		const counting = countingRepository();
		const { call } = fixture(principal(ALL_SCOPES), counting.repository);

		/* A workspace nobody has read yet gets its rows, because the retention
		   sweep finds a class through them and never through the registry. */
		expect((await call('/api/audit/data-classes')).status).toBe(200);
		expect(counting.writes()).toBe(1);

		counting.reset();
		const response = await call('/api/audit/data-classes');

		expect(response.status).toBe(200);
		expect(counting.writes()).toBe(0);
		expect(
			(
				(await response.json()) as {
					modules: { moduleId: string; classes: unknown[] }[];
				}
			).modules.flatMap((entry) => entry.classes).length,
		).toBeGreaterThan(0);
	});
});
