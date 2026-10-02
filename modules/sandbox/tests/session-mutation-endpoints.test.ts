import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { createSandboxRoutes } from '../src/api/endpoints.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';

const ORIGIN = 'https://erp.example';

const principal: AuthPrincipal = {
	accountId: 'account-a',
	tenantId: 'tenant-a',
	email: 'ada@example.com',
	displayName: 'Ada',
	role: 'owner',
	scopes: ['sandbox.access.use', 'sandbox.modules.eject'],
	tenants: [],
};

const mutations = [
	{
		name: 'register session',
		path: '/api/sandbox/sessions',
		body: {
			sessionId: 'session-a',
			moduleId: 'finance.core',
			title: 'Finance module',
			blueprint: 'new-module@1.0.0',
			driver: 'codex',
			mode: 'loopback',
		},
	},
	{
		name: 'update session state',
		path: '/api/sandbox/sessions/state',
		body: { sessionId: 'session-a', state: 'editing' },
	},
	{
		name: 'record eject',
		path: '/api/sandbox/sessions/eject',
		body: { sessionId: 'session-a', metadata: {} },
	},
] as const;

function routes() {
	const service = vi.fn(async () => {
		throw new Error('A denied mutation must not reach the sandbox service.');
	});
	const runtime = {
		options: { sandboxUrl: 'http://127.0.0.1:4320' },
		service,
	} as unknown as SandboxRuntime;
	return { routes: createSandboxRoutes({} as AuthRuntime, runtime), service };
}

async function call(
	routes: ReturnType<typeof createSandboxRoutes>,
	path: string,
	method: 'GET' | 'POST',
	options: {
		readonly token: boolean;
		readonly allowWrites?: boolean;
		readonly body?: object;
	},
): Promise<Response> {
	const headers = new Headers();
	if (options.token) headers.set('authorization', 'Bearer test-token');
	if (options.body) headers.set('content-type', 'application/json');
	const request = new Request(ORIGIN + path, {
		method,
		headers,
		body: options.body ? JSON.stringify(options.body) : null,
	});
	const state = new Map<string, unknown>();
	if (!options.token) state.set(AUTH_PRINCIPAL_STATE_KEY, principal);
	const route = routes.find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes(method),
	);
	if (!route) throw new Error(`Route ${method} ${path} is missing.`);
	const context = {
		request,
		params: {},
		url: new URL(request.url),
		state,
	} as never;
	if (!options.token) return route.handler(context);
	const authentication = createAuthenticationMiddleware(
		async () =>
			({
				resolveSession: async () => null,
				resolveApiTokenIdentity: async () => ({
					principal,
					allowWrites: options.allowWrites === true,
					allowedOrigins: [],
					tokenId: 'token-a',
					rateLimitPerMinute: 0,
				}),
			}) as unknown as Awaited<ReturnType<AuthRuntime['service']>>,
		{ name: 'sandbox_test_session', secure: false, maxAgeSeconds: 3600 },
	);
	return authentication(context, () => Promise.resolve(route.handler(context)));
}

describe('sandbox API token write authority', () => {
	it.each(mutations)(
		'SANDBOX-DENY-UNAUTHORIZED: refuses $name for a read-only token',
		async ({ path, body }) => {
			const fixture = routes();
			const response = await call(fixture.routes, path, 'POST', {
				token: true,
				allowWrites: false,
				body,
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: 'TOKEN_MUTATION_DENIED' },
			});
			expect(fixture.service).not.toHaveBeenCalled();
		},
	);

	it.each([
		{
			name: 'read-only token',
			token: true,
			allowWrites: false,
			expected: false,
		},
		{ name: 'writable token', token: true, allowWrites: true, expected: true },
		{ name: 'browser session', token: false, expected: true },
	])('SANDBOX-AUTHORIZE: reports write authority for $name', async (caller) => {
		const authorize = vi.fn(async () => ({
			granted: true,
			capabilities: ['sandbox.access.use'],
		}));
		const runtime = {
			options: { sandboxUrl: 'http://127.0.0.1:4320' },
			service: async () => ({ authorize }),
		} as unknown as SandboxRuntime;
		const response = await call(
			createSandboxRoutes({} as AuthRuntime, runtime),
			'/api/sandbox/authority',
			'GET',
			caller,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			writeAllowed: caller.expected,
		});
		expect(authorize).toHaveBeenCalledOnce();
	});
});
