import type { DatabaseProvider } from '@flowdular/database';
import type { AgentTool } from '@flowdular/harness';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	AUTH_SESSION_STATE_KEY,
	type AuthRuntime,
	type PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	createDataClassRegistry,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	type PlatformCapabilityRegistry,
} from '@flowdular/kernel';
import type { ModuleAgentDefinition } from '../../src/domain/types.ts';
import {
	createServerComposition,
	type AgentServerComposition,
} from '../../src/platform.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

export const ALL_AGENT_SCOPES = [
	'agents.definitions.read',
	'agents.definitions.manage',
	'agents.runs.read',
	'agents.runs.execute',
	'agents.providers.read',
	'agents.providers.manage',
	'agents.providers.test',
	'agents.skills.read',
	'agents.skills.manage',
];

export function agentPrincipal(
	tenantId: string,
	scopes: readonly string[] = ALL_AGENT_SCOPES,
	accountId = `owner-${tenantId}`,
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

/* Session resolution is stubbed; auth.core's own suite covers it. */
function authRuntime(): AuthRuntime {
	return {
		cookie: { name: 'coreloom_session_dev', secure: false, maxAgeSeconds: 60 },
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => ALL_AGENT_SCOPES,
		middleware: (_context: unknown, next: () => Promise<Response>) => next(),
		service: () => ({ resolveSession: () => null }),
	} as unknown as AuthRuntime;
}

export interface ComposedAgents {
	readonly composed: AgentServerComposition;
	readonly capabilities: PlatformCapabilityRegistry;
	/* One request as `principal`, through the route the platform would serve. */
	call(
		principal: AuthPrincipal,
		path: string,
		init?: RequestInit,
	): Promise<Response>;
	mutation(
		principal: AuthPrincipal,
		path: string,
		body: unknown,
	): Promise<Response>;
}

/* One agents.core instance, web or worker, composed the way the platform does
   it. Several of them over one database are several deployments or roles. */
export function composeAgents(options: {
	readonly databases: DatabaseProvider;
	readonly agents?: readonly ModuleAgentDefinition[];
	readonly tools?: readonly AgentTool[];
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly environment?: Readonly<Record<string, string>>;
}): ComposedAgents {
	const tools = [...(options.tools ?? [])];
	const agentDefinitions = createPlatformAgentRegistry();
	agentDefinitions.register([...(options.agents ?? [])]);
	const context = {
		environment: {
			FD_AGENT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
			FD_AGENT_RUN_GRANT_KEY: Buffer.alloc(32, 8).toString('base64'),
			...options.environment,
		},
		workspaceRoot: process.cwd(),
		databases: options.databases,
		auth: authRuntime(),
		...(options.settings
			? {
					settings: {
						prime: async () => {},
						get: (_tenantId: string, _moduleId: string, key: string) =>
							options.settings![key],
					},
				}
			: {}),
		agentTools: {
			register: (registered: readonly AgentTool[]) => tools.push(...registered),
			list: () => tools,
		},
		agentDefinitions,
		dataClasses: createDataClassRegistry().forModule('agents.core'),
		capabilities: createPlatformCapabilityRegistry(),
	};
	const composed = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	const call = async (
		principal: AuthPrincipal,
		path: string,
		init: RequestInit = {},
	): Promise<Response> => {
		const request = new Request(ORIGIN + path, init);
		const method = init.method ?? 'GET';
		const route = composed.routes.find(
			(candidate) =>
				candidate.path === path.split('?')[0] &&
				candidate.methods.includes(method),
		);
		if (!route) throw new Error(`Route ${method} ${path} is missing.`);
		const state = new Map<string, unknown>([
			[AUTH_PRINCIPAL_STATE_KEY, principal],
			[
				AUTH_SESSION_STATE_KEY,
				{ principal, csrfToken: CSRF_TOKEN, expiresAt: 0 },
			],
		]);
		return route.handler({
			request,
			params: {},
			url: new URL(request.url),
			state,
		} as never);
	};
	return {
		composed,
		capabilities: context.capabilities,
		call,
		mutation: (principal, path, body) =>
			call(principal, path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
					'x-csrf-token': CSRF_TOKEN,
				},
				body: JSON.stringify(body),
			}),
	};
}

/* A tenant-created agent, active, with one run queued through `target`. */
export async function queueTenantRun(
	target: ComposedAgents,
	tenant: string,
): Promise<string> {
	const definition = {
		key: 'tenant-agent',
		name: 'Tenant agent',
		description: 'Owned by the workspace.',
		instructions: 'Answer briefly.',
		provider: 'local-simulation',
		model: 'deterministic-v1',
		allowedTools: [],
		procedureIds: [],
		maxSteps: 2,
		timeoutMs: 5_000,
		temperature: 0,
		status: 'draft',
	};
	const principal = agentPrincipal(tenant);
	const created = await target.mutation(principal, '/api/agents', definition);
	const { agent } = (await created.json()) as {
		agent: { id: string; revision: number };
	};
	const activated = await target.mutation(principal, '/api/agents/update', {
		...definition,
		id: agent.id,
		expectedRevision: agent.revision,
		status: 'active',
	});
	if (activated.status !== 200) {
		throw new Error(`Activation answered ${activated.status}.`);
	}
	const queued = await target.mutation(principal, '/api/agent-runs', {
		agentId: agent.id,
		input: 'Answer briefly.',
		toolGrants: [],
	});
	if (queued.status !== 202)
		throw new Error(`Enqueue answered ${queued.status}.`);
	return ((await queued.json()) as { run: { id: string } }).run.id;
}
