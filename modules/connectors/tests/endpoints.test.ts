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

function fixture(session: AuthPrincipal | null, portedDefinition = false) {
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
		} = {},
	) => {
		const {
			authenticated = true,
			csrf = true,
			requestPath,
			...requestInit
		} = init;
		const method = requestInit.method ?? 'GET';
		const headers = new Headers(requestInit.headers);
		if (authenticated && session) {
			headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
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
		expect(instances.body.instances).toEqual([]);
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
