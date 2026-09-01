import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@coreloom/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
	type PlatformServerContext,
} from '@coreloom/module-auth/server';
import type { AgentTool } from '@coreloom/harness';
import { createServerComposition } from '../src/platform.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

function principal(
	scopes: readonly string[],
	accountId = 'account-a',
): AuthPrincipal {
	return {
		accountId,
		tenantId: 'tenant-http',
		email: `${accountId}@example.com`,
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* Session resolution is stubbed: the tests observe the agents routes, not
   auth.core's password or cookie handling, which its own suite covers. */
function authRuntime(session: AuthPrincipal | null): AuthRuntime {
	return {
		cookie: { name: 'oerp_session_dev', secure: false, maxAgeSeconds: 3_600 },
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		middleware: (_context: unknown, next: () => Promise<Response>) => next(),
		service: () =>
			({
				resolveSession: (token: string | null) =>
					session && token === SESSION_TOKEN
						? { principal: session, csrfToken: CSRF_TOKEN, expiresAt: 0 }
						: null,
			}) as unknown as ReturnType<AuthRuntime['service']>,
	} as unknown as AuthRuntime;
}

const readOnlyTool: AgentTool = {
	id: 'parties.customer.read',
	transport: 'api',
	target: 'parties.records.get',
	description: 'Read one customer.',
	requiredPermissions: ['parties.records.read'],
	execute: async () => ({}),
};

function composition(session: AuthPrincipal | null) {
	const registered: AgentTool[] = [];
	const context = {
		environment: { OERP_AGENTS_DATABASE: ':memory:' },
		workspaceRoot: process.cwd(),
		auth: authRuntime(session),
		agentTools: {
			register: (tools: readonly AgentTool[]) => registered.push(...tools),
			list: () => registered,
		},
	};
	const composed = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	const route = (path: string, method: string) => {
		const found = composed.routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(method),
		);
		if (!found) throw new Error(`Route ${method} ${path} is missing.`);
		return found;
	};
	const call = (
		path: string,
		init: RequestInit & { readonly authenticated?: boolean } = {},
	) => {
		const { authenticated = true, ...requestInit } = init;
		const request = new Request(ORIGIN + path, requestInit);
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		if (authenticated && session) {
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, session);
		}
		return route(path.split('?')[0]!, requestInit.method ?? 'GET').handler(
			context as never,
		);
	};
	const mutation = (path: string, body: unknown, headers: HeadersInit = {}) =>
		call(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: `oerp_session_dev=${SESSION_TOKEN}`,
				'x-csrf-token': CSRF_TOKEN,
				...headers,
			},
			body: JSON.stringify(body),
		});
	return { composed, context, call, mutation };
}

const ALL_SCOPES = [
	'agents.definitions.read',
	'agents.definitions.manage',
	'agents.runs.read',
	'agents.runs.execute',
	'agents.providers.read',
];

async function activeAgentId(
	mutation: ReturnType<typeof composition>['mutation'],
): Promise<string> {
	const definition = {
		key: 'http-agent',
		name: 'HTTP agent',
		description: 'Exercises the HTTP boundary.',
		instructions: 'Answer briefly and factually.',
		provider: 'local-simulation',
		model: 'deterministic-v1',
		allowedTools: [],
		skillIds: [],
		maxSteps: 2,
		timeoutMs: 5_000,
		temperature: 0,
		status: 'draft',
	};
	const created = (await (
		await mutation('/api/agents', definition)
	).json()) as {
		agent: { id: string; revision: number };
	};
	const activated = await mutation('/api/agents/update', {
		...definition,
		id: created.agent.id,
		expectedRevision: created.agent.revision,
		status: 'active',
	});
	expect(activated.status).toBe(200);
	return created.agent.id;
}

describe('agents HTTP boundary', () => {
	it('denies unauthenticated and under-scoped reads before touching the tenant', async () => {
		const anonymous = composition(null);
		const unauthenticated = await anonymous.call('/api/agent-runs', {
			authenticated: false,
		});
		expect(unauthenticated.status).toBe(401);

		const reader = composition(principal(['agents.definitions.read']));
		const forbidden = await reader.call('/api/agent-runs');
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({
			error: { code: 'FORBIDDEN' },
		});
	});

	it('rejects a mutation without a CSRF token and one from another origin', async () => {
		const { mutation } = composition(principal(ALL_SCOPES));
		const missingCsrf = await mutation(
			'/api/agent-runs',
			{ agentId: 'x', input: 'hello', toolGrants: [] },
			{ 'x-csrf-token': '' },
		);
		expect(missingCsrf.status).toBe(403);
		expect(await missingCsrf.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
		const crossOrigin = await mutation(
			'/api/agent-runs',
			{ agentId: 'x', input: 'hello', toolGrants: [] },
			{ origin: 'https://attacker.example' },
		);
		expect(crossOrigin.status).toBe(403);
	});

	it('owns the trigger of a browser-enqueued run and exposes worker status', async () => {
		const { composed, mutation, call } = composition(principal(ALL_SCOPES));
		composed.start();
		const agentId = await activeAgentId(mutation);
		const queued = await mutation('/api/agent-runs', {
			agentId,
			trigger: 'schedule',
			input: 'Summarize the open orders.',
			toolGrants: [],
		});
		expect(queued.status).toBe(202);
		expect(await queued.json()).toMatchObject({
			run: { trigger: 'playground', status: 'queued' },
		});
		const worker = await call('/api/agent-runs/worker');
		expect(await worker.json()).toMatchObject({
			worker: { online: true, concurrency: expect.any(Number) },
		});
	});

	it('lets only the requester or a manager cancel a run', async () => {
		const requester = composition(
			principal([
				'agents.runs.execute',
				'agents.definitions.manage',
				'agents.definitions.read',
			]),
		);
		const agentId = await activeAgentId(requester.mutation);
		const queued = (await (
			await requester.mutation('/api/agent-runs', {
				agentId,
				input: 'Cancel me.',
				toolGrants: [],
			})
		).json()) as { run: { id: string } };
		/* Same composition, different principal: the state carries who calls. */
		const other = principal(['agents.runs.execute'], 'account-b');
		const request = new Request(ORIGIN + '/api/agent-runs/cancel', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: `oerp_session_dev=${SESSION_TOKEN}`,
				'x-csrf-token': CSRF_TOKEN,
			},
			body: JSON.stringify({ id: queued.run.id }),
		});
		const cancelRoute = requester.composed.routes.find(
			(route) => route.path === '/api/agent-runs/cancel',
		)!;
		const denied = await cancelRoute.handler({
			request,
			params: {},
			url: new URL(request.url),
			state: new Map([[AUTH_PRINCIPAL_STATE_KEY, other]]),
		} as never);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({
			error: { code: 'RUN_CANCEL_FORBIDDEN' },
		});
		const cancelled = await requester.mutation('/api/agent-runs/cancel', {
			id: queued.run.id,
		});
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toMatchObject({
			run: { status: 'cancelled' },
		});
	});

	it('sees tools that other modules registered after it was composed', async () => {
		const { composed, context, call } = composition(principal(ALL_SCOPES));
		context.agentTools.register([readOnlyTool]);
		composed.start();
		const response = await call('/api/agents');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			tools: ['parties.customer.read'],
		});
	});
});
