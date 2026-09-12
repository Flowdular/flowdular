import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { createPlatformCapabilityRegistry } from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import { WORKFLOWS_PERMISSIONS } from '../../src/acl/permissions.ts';
import { createWorkflowsRoutes } from '../../src/api/endpoints.ts';
import type { WorkflowsRuntime } from '../../src/server/runtime.ts';
import type { WorkflowsRuntimeOptions } from '../../src/server/runtime.ts';
import { createWorkflowsTestRuntime } from './database.ts';

export const ORIGIN = 'https://erp.example';
export const SESSION_TOKEN = 'session-token-0001';
export const CSRF_TOKEN = 'csrf-token-0001';
const COOKIE_NAME = 'coreloom_session_dev';

/* Everything a browser session needs to create, publish and run a workflow
   whose graph carries no agent or action node. */
export const ALL_SCOPES: readonly string[] = [
	...Object.values(WORKFLOWS_PERMISSIONS),
	'agents.definitions.read',
	'agents.runs.read',
	'agents.runs.execute',
];

export function principal(
	scopes: readonly string[] = ALL_SCOPES,
	tenantId = 'tenant-a',
): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId,
		email: 'owner@example.test',
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* Live capabilities that no test graph reaches: publish and enqueue refuse
   without them, and a direct input-to-output graph never calls them. */
export function executionCapabilities() {
	const registry = createPlatformCapabilityRegistry();
	const agents: AgentRevisionExecutionCapability = {
		listRevisions: async () => [],
		getRevision: async () => null,
		enqueueRevision: async () => {
			throw new Error('No agent node is expected in this test.');
		},
		readEvents: async () => [],
		getResult: async () => null,
		requestCancel: async () => false,
	};
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: async () => [],
		start: async () => {
			throw new Error('No action node is expected in this test.');
		},
		getResult: async () => null,
		requestCancel: async (actionInvocationId) => ({
			actionInvocationId,
			state: 'not-supported',
		}),
	};
	registry.register(AGENT_RUN_EXECUTION_CAPABILITY, agents);
	registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, actions);
	return registry;
}

/* The real authentication middleware publishes the principal and the session
   the CSRF guard reads, so the routes see the same state the platform gives
   them rather than a hand-placed principal. */
function authRuntime(session: AuthPrincipal): AuthRuntime {
	const cookie = { name: COOKIE_NAME, secure: false, maxAgeSeconds: 3_600 };
	const service = {
		resolveSession: async (token: string | null) =>
			token === SESSION_TOKEN
				? { principal: session, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null,
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

export interface MutationOptions {
	/** Overrides the session's token; omitted on purpose by the CSRF case. */
	readonly csrfToken?: string | undefined;
}

export interface HttpHarness {
	readonly runtime: WorkflowsRuntime;
	call(path: string): Promise<Response>;
	mutation(
		path: string,
		body: unknown,
		options?: MutationOptions,
	): Promise<Response>;
	dispose(): Promise<void>;
}

/**
 * workflows.core routes in front of a browser session on an embedded
 * PostgreSQL. `call` is a GET, `mutation` a same-origin POST carrying the
 * session cookie and its CSRF token.
 */
export function openHttpHarness(
	options: Omit<WorkflowsRuntimeOptions, 'databases'> = {},
	session: AuthPrincipal = principal(),
): HttpHarness {
	const runtime = createWorkflowsTestRuntime({
		capabilities: executionCapabilities(),
		...options,
	});
	const auth = authRuntime(session);
	const routes = createWorkflowsRoutes(auth, runtime);
	const invoke = async (path: string, init: RequestInit): Promise<Response> => {
		const method = init.method ?? 'GET';
		const pathname = path.split('?')[0]!;
		const route = routes.find(
			(candidate) =>
				candidate.path === pathname && candidate.methods.includes(method),
		);
		if (!route) throw new Error(`workflows.core exposes no ${method} ${path}.`);
		const headers = new Headers(init.headers);
		headers.set('cookie', `${COOKIE_NAME}=${SESSION_TOKEN}`);
		const request = new Request(ORIGIN + path, { ...init, headers });
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route.handler(context as never);
	};
	return {
		runtime,
		call: (path) => invoke(path, {}),
		mutation: (path, body, options = {}) =>
			invoke(path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					'x-csrf-token': options.csrfToken ?? CSRF_TOKEN,
				},
				body: JSON.stringify(body),
			}),
		dispose: async () => {
			await runtime.dispose();
		},
	};
}
