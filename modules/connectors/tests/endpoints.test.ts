import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { CONNECTORS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createConnectorsRoutes, endpoints } from '../src/api/endpoints.ts';
import { HTTP_JSON_DEFINITION } from '../src/domain/http-json.ts';
import { createConnectorsRuntime } from '../src/server/runtime.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
	TEST_DEFINITION_KEY,
	TEST_LIMITS,
	portedTestDefinition,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testConnect,
	testResolver,
	testVault,
	type TestServer,
} from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const OTHER_SESSION_TOKEN = 'session-token-0002';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const ALL_SCOPES = Object.values(CONNECTORS_PERMISSIONS);

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
		resolveApiTokenIdentity: async () => null,
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

let shared: ConnectorsTestDatabase;
let server: TestServer;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	server = await startTestServer(() => ({ body: '{"ok":true}' }));
});

afterAll(async () => {
	await server?.close();
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function fixture(
	session: AuthPrincipal | null,
	portedDefinition = false,
	/* A second signed-in principal on the same routes, so a cursor one
	   workspace was handed can be presented by another. */
	other: AuthPrincipal | null = null,
) {
	const runtime = createConnectorsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		vault: testVault(),
		limits: () => TEST_LIMITS,
		hostResolver: testResolver(),
		connect: testConnect(),
	});
	/* The shipped generic definition accepts 443 only, so a test that reaches
	   the suite's own server registers a definition for its port. */
	if (portedDefinition) runtime.definitions.register(portedTestDefinition());
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	if (other) sessions.set(OTHER_SESSION_TOKEN, other);
	const auth = authRuntime(sessions);
	const routes = createConnectorsRoutes(auth, runtime);
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
		init: RequestInit & {
			readonly authenticated?: boolean;
			readonly csrf?: boolean;
			readonly requestPath?: string;
			readonly asOther?: boolean;
		} = {},
	) => {
		const {
			authenticated = true,
			csrf = true,
			requestPath,
			asOther = false,
			...requestInit
		} = init;
		const method = requestInit.method ?? 'GET';
		const headers = new Headers(requestInit.headers);
		if (authenticated && session) {
			headers.set(
				'cookie',
				`coreloom_session_dev=${asOther ? OTHER_SESSION_TOKEN : SESSION_TOKEN}`,
			);
		}
		if (method !== 'GET') {
			headers.set('origin', ORIGIN);
			if (!headers.has('content-type')) {
				headers.set('content-type', 'application/json');
			}
			if (csrf) headers.set('x-csrf-token', CSRF_TOKEN);
		}
		const request = new Request(ORIGIN + (requestPath ?? path), {
			...requestInit,
			method,
			headers,
		});
		/* The route handler receives the context the middleware published, so the
		   test builds it exactly the way the server does. */
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		const response = await route(path, method).handler(context as never);
		return {
			status: response.status,
			body: (await response.clone().json()) as Record<string, unknown>,
		};
	};
	return { invoke, routes, runtime };
}

describe('CONNECTORS-DENY', () => {
	it('denies an unauthenticated read before any repository access', async () => {
		const { invoke } = fixture(null);
		const listed = await invoke('/api/connectors/instances', {
			authenticated: false,
		});
		expect(listed.status).toBe(401);
		expect(listed.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
	});

	it('denies a principal without the read permission', async () => {
		const { invoke } = fixture(principal([]));
		for (const path of [
			'/api/connectors/instances',
			'/api/connectors/definitions',
			'/api/connectors/calls',
		]) {
			const denied = await invoke(path);
			expect([path, denied.status]).toEqual([path, 403]);
			expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN' });
		}
	});

	it('denies a mutation to a principal holding only the read permission', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		const denied = await invoke('/api/connectors/instances', {
			method: 'POST',
			body: JSON.stringify({
				definitionKey: HTTP_JSON_DEFINITION.key,
				name: 'Billing',
				baseUrl: 'https://api.example.test',
				authKind: 'none',
			}),
		});
		expect(denied.status).toBe(403);
		expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN' });
	});

	/* CSRF is checked before the body is read, so a mutation without the proof
	   is refused even when everything else about it is valid. */
	it('refuses a mutation without a CSRF proof first', async () => {
		const { invoke } = fixture(principal(ALL_SCOPES));
		for (const path of [
			'/api/connectors/instances/update',
			'/api/connectors/instances/consent',
			'/api/connectors/instances/test-call',
			'/api/connectors/instances/enable',
			'/api/connectors/instances/disable',
			'/api/connectors/instances/delete',
		]) {
			const denied = await invoke(path, {
				method: 'POST',
				csrf: false,
				body: JSON.stringify({ id: 'whatever' }),
			});
			expect([path, denied.status]).toEqual([path, 403]);
			expect([path, denied.body.error]).toEqual([
				path,
				expect.objectContaining({ code: 'CSRF_REJECTED' }),
			]);
		}
	});

	it('serves the definitions and an empty instance list to a reader', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		const definitions = await invoke('/api/connectors/definitions');
		expect(definitions.status).toBe(200);
		expect(
			(definitions.body.definitions as readonly { key: string }[]).map(
				(entry) => entry.key,
			),
		).toEqual([HTTP_JSON_DEFINITION.key]);
		const instances = await invoke('/api/connectors/instances');
		expect(instances.body.items).toEqual([]);
		expect(instances.body.page).toEqual({ nextCursor: null, limit: 50 });
	});

	it('creates, consents, tests and deletes through the routes a manager holds', async () => {
		const { invoke } = fixture(principal(ALL_SCOPES));
		const created = await invoke('/api/connectors/instances', {
			method: 'POST',
			body: JSON.stringify({
				definitionKey: HTTP_JSON_DEFINITION.key,
				name: 'Billing',
				baseUrl: 'https://api.example.test/v1',
				authKind: 'bearer',
				credentials: { token: 'bearer-token-0001' },
				allowedHosts: ['api.example.test'],
			}),
		});
		expect(created.status).toBe(201);
		const instance = created.body.instance as {
			id: string;
			credentialFingerprint: string;
		};
		expect(JSON.stringify(created.body)).not.toContain('bearer-token-0001');

		const consented = await invoke('/api/connectors/instances/consent', {
			method: 'POST',
			body: JSON.stringify({
				id: instance.id,
				allowWorkflows: true,
				allowAgents: false,
				confirmed: true,
			}),
		});
		expect(consented.body.instance).toMatchObject({
			allowWorkflows: true,
			allowAgents: false,
		});

		const disabled = await invoke('/api/connectors/instances/disable', {
			method: 'POST',
			body: JSON.stringify({ id: instance.id }),
		});
		expect(disabled.body.instance).toMatchObject({ status: 'disabled' });

		const removed = await invoke('/api/connectors/instances/delete', {
			method: 'POST',
			body: JSON.stringify({ id: instance.id }),
		});
		expect(removed.body).toEqual({ deleted: true });
	});

	it('returns a test call diagnosis without a parsed body', async () => {
		const { invoke, runtime } = fixture(principal(ALL_SCOPES), true);
		const instance = await seedInstance(shared.repository, testVault(), {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
		});
		const result = await invoke('/api/connectors/instances/test-call', {
			method: 'POST',
			body: JSON.stringify({
				id: instance.id,
				operation: 'get',
				input: { path: '/things' },
			}),
		});
		expect(result.status).toBe(200);
		expect(result.body.result).toMatchObject({
			outcome: 'succeeded',
			status: 200,
			bodyPreview: '{"ok":true}',
		});
		expect(Object.keys(result.body.result as object)).not.toContain('body');
		await runtime.dispose();
	});

	/* The tool runs in process. A route under the read permission that made a
	   credentialed call and handed back the parsed body would give every member
	   the connector itself, so no route serves the tool's id. */
	it('serves no route for the agent tool, under any method', () => {
		const { routes } = fixture(principal(ALL_SCOPES));
		expect(
			routes.filter((route) => route.path === '/api/connectors/agent-call'),
		).toEqual([]);
		expect(endpoints).not.toContain('connectors.calls.agent');
	});

	it('rejects a body that is not JSON and one that is too large', async () => {
		const { invoke } = fixture(principal(ALL_SCOPES));
		const notJson = await invoke('/api/connectors/instances/enable', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'id=1',
		});
		expect(notJson.status).toBe(415);
		const tooLarge = await invoke('/api/connectors/instances/enable', {
			method: 'POST',
			body: JSON.stringify({ id: 'a'.repeat(20_000) }),
		});
		expect(tooLarge.status).toBe(413);
	});
});

interface Page {
	readonly items: readonly {
		readonly id: string;
		readonly name?: string;
		readonly instanceName?: string | null;
	}[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

function ids(page: Record<string, unknown>): readonly string[] {
	return (page as unknown as Page).items.map((entry) => entry.id);
}

function nextCursor(page: Record<string, unknown>): string {
	const cursor = (page as unknown as Page).page.nextCursor;
	if (cursor === null) throw new Error('The page has no next cursor.');
	return cursor;
}

async function seedInstances(names: readonly string[], tenantId = TENANT) {
	const vault = testVault();
	const seeded = [];
	for (const name of names) {
		seeded.push(
			await seedInstance(shared.repository, vault, {
				tenantId,
				baseUrl: 'https://api.example.test/v1',
				name,
				status: name.startsWith('d') ? 'disabled' : 'active',
			}),
		);
	}
	return seeded;
}

async function seedCalls(instanceId: string, count: number, tenantId = TENANT) {
	for (let index = 0; index < count; index += 1) {
		await shared.repository.recordCall(
			{
				id: `call-${String(index).padStart(3, '0')}`,
				tenantId,
				instanceId,
				operation: index % 2 === 0 ? 'get' : 'post',
				caller: 'test',
				callerRef: null,
				outcome: index % 3 === 0 ? 'failed' : 'succeeded',
				status: 200,
				errorClass: null,
				durationMs: 1,
				requestBytes: 0,
				responseBytes: 0,
				/* Two calls per instant, so the id tiebreak is exercised. */
				occurredAt: 1_000 + Math.floor(index / 2),
			},
			null,
		);
	}
}

describe('CONNECTORS-INSTANCES-PAGING', () => {
	const NAMES = ['delta', 'Alpha', 'charlie', 'Bravo', 'echo'];

	it('walks consecutive pages in name order with no overlap and no gap', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		await seedInstances(NAMES);
		const whole = await invoke('/api/connectors/instances');
		expect(
			(whole.body as unknown as Page).items.map((entry) => entry.name),
		).toEqual(['Alpha', 'Bravo', 'charlie', 'delta', 'echo']);
		expect((whole.body as unknown as Page).page.nextCursor).toBeNull();

		const first = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?limit=2',
		});
		expect(ids(first.body)).toEqual(ids(whole.body).slice(0, 2));
		const second = await invoke('/api/connectors/instances', {
			requestPath: `/api/connectors/instances?limit=2&cursor=${nextCursor(first.body)}`,
		});
		expect(ids(second.body)).toEqual(ids(whole.body).slice(2, 4));
		const third = await invoke('/api/connectors/instances', {
			requestPath: `/api/connectors/instances?limit=2&cursor=${nextCursor(second.body)}`,
		});
		expect(ids(third.body)).toEqual(ids(whole.body).slice(4));
		expect((third.body as unknown as Page).page.nextCursor).toBeNull();
	});

	it('hands out a cursor on a full page only', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		await seedInstances(NAMES.slice(0, 2));
		const full = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?limit=2',
		});
		expect(ids(full.body)).toHaveLength(2);
		expect((full.body as unknown as Page).page.nextCursor).not.toBeNull();
		const short = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?limit=3',
		});
		expect(ids(short.body)).toHaveLength(2);
		expect((short.body as unknown as Page).page.nextCursor).toBeNull();
	});

	it('reverses the walk under direction desc and narrows by status', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		await seedInstances(NAMES);
		const whole = await invoke('/api/connectors/instances');
		const descending = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?direction=desc&limit=3',
		});
		expect(ids(descending.body)).toEqual(
			[...ids(whole.body)].reverse().slice(0, 3),
		);
		const rest = await invoke('/api/connectors/instances', {
			requestPath: `/api/connectors/instances?direction=desc&limit=3&cursor=${nextCursor(descending.body)}`,
		});
		expect(ids(rest.body)).toEqual([...ids(whole.body)].reverse().slice(3));

		const disabled = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?status=disabled',
		});
		expect(
			(disabled.body as unknown as Page).items.map((entry) => entry.name),
		).toEqual(['delta']);
		const searched = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?q=HA',
		});
		expect(
			(searched.body as unknown as Page).items.map((entry) => entry.name),
		).toEqual(['Alpha', 'charlie']);
	});

	it('refuses a tampered cursor, a foreign cursor and a cursor from other filters', async () => {
		const other = principal(
			[CONNECTORS_PERMISSIONS.read],
			'account-bob',
			'tenant-other',
		);
		const { invoke } = fixture(
			principal([CONNECTORS_PERMISSIONS.read]),
			false,
			other,
		);
		await seedInstances(NAMES);
		await seedInstances(['zulu', 'yankee'], 'tenant-other');
		const first = await invoke('/api/connectors/instances', {
			requestPath: '/api/connectors/instances?limit=2',
		});
		const cursor = nextCursor(first.body);

		const tampered = await invoke('/api/connectors/instances', {
			requestPath: `/api/connectors/instances?limit=2&cursor=${cursor.slice(0, -4)}AAAA`,
		});
		expect(tampered.status).toBe(400);
		expect(tampered.body.error).toMatchObject({ code: 'CURSOR_INVALID' });

		const foreign = await invoke('/api/connectors/instances', {
			requestPath: `/api/connectors/instances?limit=2&cursor=${cursor}`,
			asOther: true,
		});
		expect(foreign.status).toBe(400);
		expect(foreign.body.error).toMatchObject({ code: 'CURSOR_INVALID' });

		for (const query of [
			'status=active',
			'direction=desc',
			'q=a',
			'definition=other',
		]) {
			const moved = await invoke('/api/connectors/instances', {
				requestPath: `/api/connectors/instances?limit=2&${query}&cursor=${cursor}`,
			});
			expect([query, moved.status]).toEqual([query, 400]);
			expect([query, moved.body.error]).toEqual([
				query,
				expect.objectContaining({ code: 'CURSOR_INVALID' }),
			]);
		}
	});

	it('refuses an unknown sort key, direction, status and limit', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		for (const query of [
			'sort=baseUrl',
			'direction=up',
			'status=retired',
			'limit=0',
			'limit=201',
			'limit=ten',
		]) {
			const refused = await invoke('/api/connectors/instances', {
				requestPath: `/api/connectors/instances?${query}`,
			});
			expect([query, refused.status]).toEqual([query, 400]);
			expect([query, refused.body.error]).toEqual([
				query,
				expect.objectContaining({ code: 'INVALID_INPUT' }),
			]);
		}
	});
});

describe('CONNECTORS-CALLS-PAGING', () => {
	it('walks the log newest first with no overlap and no gap, and oldest first on request', async () => {
		const { invoke } = fixture(principal([CONNECTORS_PERMISSIONS.read]));
		const [instance] = await seedInstances(['Billing']);
		await seedCalls(instance!.id, 7);
		const whole = await invoke('/api/connectors/calls');
		expect(ids(whole.body)).toHaveLength(7);
		expect(ids(whole.body)[0]).toBe('call-006');
		expect((whole.body as unknown as Page).items[0]).toMatchObject({
			instanceName: 'Billing',
		});
		expect((whole.body as unknown as Page).page.nextCursor).toBeNull();

		const walked: string[] = [];
		let path = '/api/connectors/calls?limit=3';
		for (let pages = 0; pages < 4; pages += 1) {
			const page = await invoke('/api/connectors/calls', { requestPath: path });
			expect(page.status).toBe(200);
			walked.push(...ids(page.body));
			const cursor = (page.body as unknown as Page).page.nextCursor;
			if (cursor === null) break;
			path = `/api/connectors/calls?limit=3&cursor=${cursor}`;
		}
		expect(walked).toEqual(ids(whole.body));

		const oldest = await invoke('/api/connectors/calls', {
			requestPath: '/api/connectors/calls?direction=asc&limit=4',
		});
		expect(ids(oldest.body)).toEqual(
			[...ids(whole.body)].reverse().slice(0, 4),
		);
		const rest = await invoke('/api/connectors/calls', {
			requestPath: `/api/connectors/calls?direction=asc&limit=4&cursor=${nextCursor(oldest.body)}`,
		});
		expect(ids(rest.body)).toEqual([...ids(whole.body)].reverse().slice(4));
		expect((rest.body as unknown as Page).page.nextCursor).toBeNull();
	});

	it('binds the cursor to the outcome, instance and operation filters', async () => {
		const other = principal(
			[CONNECTORS_PERMISSIONS.read],
			'account-bob',
			'tenant-other',
		);
		const { invoke } = fixture(
			principal([CONNECTORS_PERMISSIONS.read]),
			false,
			other,
		);
		const [instance] = await seedInstances(['Billing']);
		await seedCalls(instance!.id, 6);
		const failed = await invoke('/api/connectors/calls', {
			requestPath: '/api/connectors/calls?outcome=failed&limit=1',
		});
		expect(ids(failed.body)).toEqual(['call-003']);
		const cursor = nextCursor(failed.body);
		const next = await invoke('/api/connectors/calls', {
			requestPath: `/api/connectors/calls?outcome=failed&limit=1&cursor=${cursor}`,
		});
		expect(ids(next.body)).toEqual(['call-000']);

		for (const query of [
			'limit=1',
			'outcome=succeeded&limit=1',
			`outcome=failed&limit=1&instanceId=${instance!.id}`,
			'outcome=failed&limit=1&q=get',
			'outcome=failed&limit=1&direction=asc',
		]) {
			const moved = await invoke('/api/connectors/calls', {
				requestPath: `/api/connectors/calls?${query}&cursor=${cursor}`,
			});
			expect([query, moved.status]).toEqual([query, 400]);
			expect([query, moved.body.error]).toEqual([
				query,
				expect.objectContaining({ code: 'CURSOR_INVALID' }),
			]);
		}
		const foreign = await invoke('/api/connectors/calls', {
			requestPath: `/api/connectors/calls?outcome=failed&limit=1&cursor=${cursor}`,
			asOther: true,
		});
		expect(foreign.status).toBe(400);
		expect(foreign.body.error).toMatchObject({ code: 'CURSOR_INVALID' });

		const searched = await invoke('/api/connectors/calls', {
			requestPath: '/api/connectors/calls?q=POS',
		});
		expect(ids(searched.body)).toEqual(['call-005', 'call-003', 'call-001']);
		const unknownSort = await invoke('/api/connectors/calls', {
			requestPath: '/api/connectors/calls?sort=durationMs',
		});
		expect(unknownSort.status).toBe(400);
		expect(unknownSort.body.error).toMatchObject({ code: 'INVALID_INPUT' });
	});
});
