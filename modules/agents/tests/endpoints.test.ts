import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	AUTH_SESSION_STATE_KEY,
	type AuthRuntime,
	type PlatformServerContext,
} from '@flowdular/module-auth/server';
import type { AgentTool } from '@flowdular/harness';
import {
	createDataClassRegistry,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	createServerComposition,
	type AgentServerComposition,
} from '../src/platform.ts';
import { defineAgent } from '../src/server/define-agent.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

function principal(
	scopes: readonly string[],
	accountId = 'account-a',
	tenantId = 'tenant-http',
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

/* Session resolution is stubbed: the tests observe the agents routes, not
   auth.core's password or cookie handling, which its own suite covers. */
function authRuntime(session: AuthPrincipal | null): AuthRuntime {
	return {
		cookie: {
			name: 'coreloom_session_dev',
			secure: false,
			maxAgeSeconds: 3_600,
		},
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => [],
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

const moduleAgent = defineAgent({
	moduleId: 'parties.core',
	key: 'customer-reviewer',
	definitionRevision: 1,
	name: 'Customer reviewer',
	description: 'Reviews customer records supplied by the parties module.',
	instructions: 'Review the customer record using only the granted tools.',
	allowedTools: [readOnlyTool.id],
	limits: {
		maxSteps: 4,
		timeoutMs: 10_000,
		temperature: 0,
		maxOutputTokens: 1_024,
	},
});

let database: AgentsTestDatabase;
const compositions: AgentServerComposition[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

afterEach(async () => {
	/* start() is fire and forget, so the chain it kicked off gets a turn to
	   finish before the runtime that owns its worker tears down. */
	for (let turn = 0; turn < 5; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (const opened of compositions.splice(0)) await opened.dispose?.();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

/* start() hands the module agent catalog and the worker to a promise chain, so
   a case that asserts on either waits for the effect, not for the call that
   scheduled it. */
function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(() => void tick(), 10);
		};
		void tick();
	});
}

function sessionState(principal: AuthPrincipal) {
	return { principal, csrfToken: CSRF_TOKEN, expiresAt: 0 };
}

function composition(session: AuthPrincipal | null) {
	const registered: AgentTool[] = [];
	const context = {
		environment: {
			FD_AGENT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
			FD_AGENT_RUN_GRANT_KEY: Buffer.alloc(32, 8).toString('base64'),
		},
		workspaceRoot: process.cwd(),
		databases: database.databases,
		auth: authRuntime(session),
		agentTools: {
			register: (tools: readonly AgentTool[]) => registered.push(...tools),
			list: () => registered,
		},
		agentDefinitions: createPlatformAgentRegistry(),
		dataClasses: createDataClassRegistry().forModule('agents.core'),
		capabilities: createPlatformCapabilityRegistry(),
	};
	const composed = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	compositions.push(composed);
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
		/* The authentication middleware resolves the cookie once per request and
		   leaves the session in state; the mutation guard reads it from there,
		   never from the runtime. */
		if (
			session &&
			(requestInit.headers as Record<string, string> | undefined)?.cookie ===
				`coreloom_session_dev=${SESSION_TOKEN}`
		) {
			context.state.set(AUTH_SESSION_STATE_KEY, sessionState(session));
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
				cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
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
	'agents.providers.manage',
	'agents.providers.test',
	'agents.skills.read',
	'agents.skills.manage',
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
		procedureIds: [],
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
	it('deletes an unused provider through the authenticated mutation boundary', async () => {
		const { call, mutation } = composition(principal(ALL_SCOPES));
		const createdResponse = await mutation('/api/agent-providers', {
			key: 'delete-me',
			name: 'Delete me',
			kind: 'openai',
			credential: 'sk-provider-test-credential',
			models: [
				{
					id: 'gpt-4o-mini',
					label: 'GPT-4o mini',
					enabled: true,
					supportsTools: true,
					supportsStreaming: true,
					supportsWebSearch: false,
				},
			],
		});
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as {
			provider: { id: string; revision: number };
		};

		const deleted = await mutation('/api/agent-providers/delete', {
			id: created.provider.id,
			expectedRevision: created.provider.revision,
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ deleted: true });

		const listed = (await (await call('/api/agent-providers')).json()) as {
			providers: { id: string }[];
		};
		expect(listed.providers.map((provider) => provider.id)).not.toContain(
			created.provider.id,
		);
	});

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

	it('guards agent lifecycle mutations with scope, CSRF, and tenant boundaries', async () => {
		const anonymous = composition(null);
		expect(
			await anonymous.call('/api/agents/delete', {
				method: 'POST',
				authenticated: false,
			}),
		).toMatchObject({ status: 401 });

		const forbidden = composition(principal(['agents.definitions.read']));
		const forbiddenResponse = await forbidden.mutation('/api/agents/delete', {
			id: 'agent-x',
			expectedRevision: 1,
		});
		expect(forbiddenResponse.status).toBe(403);

		const owner = composition(principal(ALL_SCOPES));
		const agentId = await activeAgentId(owner.mutation);
		const listed = (await (await owner.call('/api/agents')).json()) as {
			agents: { id: string; revision: number }[];
		};
		const agent = listed.agents.find((item) => item.id === agentId)!;
		const archived = await owner.mutation('/api/agents/archive', {
			id: agent.id,
			expectedRevision: agent.revision,
		});
		expect(archived.status).toBe(200);
		const archivedAgent = (await archived.json()) as {
			agent: { id: string; revision: number };
		};

		const missingCsrf = await owner.call('/api/agents/delete', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
			},
			body: JSON.stringify({
				id: archivedAgent.agent.id,
				expectedRevision: archivedAgent.agent.revision,
			}),
		});
		expect(missingCsrf.status).toBe(403);
		expect(await missingCsrf.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});

		const deleteRoute = owner.composed.routes.find(
			(route) => route.path === '/api/agents/delete',
		)!;
		const otherTenant = await deleteRoute.handler({
			request: new Request(ORIGIN + '/api/agents/delete', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
					'x-csrf-token': CSRF_TOKEN,
				},
				body: JSON.stringify({
					id: archivedAgent.agent.id,
					expectedRevision: archivedAgent.agent.revision,
				}),
			}),
			params: {},
			url: new URL(ORIGIN + '/api/agents/delete'),
			state: new Map<string, unknown>([
				[
					AUTH_PRINCIPAL_STATE_KEY,
					principal(ALL_SCOPES, 'account-b', 'tenant-other'),
				],
				[
					AUTH_SESSION_STATE_KEY,
					sessionState(principal(ALL_SCOPES, 'account-b', 'tenant-other')),
				],
			]),
		} as never);
		expect(otherTenant.status).toBe(404);
		expect(await otherTenant.json()).toMatchObject({
			error: { code: 'AGENT_NOT_FOUND' },
		});
	});

	it('guards the agent audit read and verify endpoints by scope', async () => {
		const anonymous = composition(null);
		expect(
			(await anonymous.call('/api/agent-audit', { authenticated: false }))
				.status,
		).toBe(401);

		const forbidden = composition(principal(['agents.definitions.read']));
		expect((await forbidden.call('/api/agent-audit')).status).toBe(403);
		expect((await forbidden.call('/api/agent-audit/verify')).status).toBe(403);

		const reader = composition(principal(['agents.runs.read']));
		const list = await reader.call('/api/agent-audit');
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({ events: [], nextCursor: null });
		const verify = await reader.call('/api/agent-audit/verify');
		expect(verify.status).toBe(200);
		expect(await verify.json()).toEqual({ verified: true, brokenAt: null });
	});

	it('rejects a malformed audit cursor with a 400', async () => {
		const reader = composition(principal(['agents.runs.read']));
		const response = await reader.call('/api/agent-audit?cursor=not-a-cursor');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_CURSOR' },
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
		await waitFor(
			async () =>
				(
					(await (await call('/api/agent-runs/worker')).json()) as {
						worker: { online: boolean };
					}
				).worker.online,
		);
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
				cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
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
			state: new Map<string, unknown>([
				[AUTH_PRINCIPAL_STATE_KEY, other],
				[AUTH_SESSION_STATE_KEY, sessionState(other)],
			]),
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

	it('serves module agents separately and keeps tenant bindings isolated', async () => {
		const { composed, context, call, mutation } = composition(
			principal(ALL_SCOPES),
		);
		context.agentTools.register([readOnlyTool]);
		context.agentDefinitions.register([moduleAgent]);
		composed.start();
		await waitFor(
			async () =>
				(
					(await (await call('/api/agents')).json()) as {
						moduleAgents: readonly unknown[];
					}
				).moduleAgents.length === 1,
		);

		const before = (await (await call('/api/agents')).json()) as {
			agents: unknown[];
			moduleAgents: Array<{
				id: string;
				status: string;
				revision: number | null;
				ownership: { kind: string; moduleId: string };
			}>;
		};
		expect(before.agents).toEqual([]);
		expect(before.moduleAgents).toMatchObject([
			{
				id: moduleAgent.id,
				status: 'unconfigured',
				revision: null,
				ownership: { kind: 'module', moduleId: 'parties.core' },
			},
		]);

		const configured = await mutation('/api/agents/module-bindings/update', {
			agentId: moduleAgent.id,
			provider: 'local-simulation',
			model: 'deterministic-v1',
			enabledTools: [readOnlyTool.id],
			status: 'active',
			expectedRevision: 0,
		});
		expect(configured.status).toBe(200);
		expect(await configured.json()).toMatchObject({
			agent: {
				id: moduleAgent.id,
				status: 'active',
				revision: 1,
				bindingRevision: 1,
				enabledTools: [readOnlyTool.id],
			},
		});

		const conflict = await mutation('/api/agents/module-bindings/update', {
			agentId: moduleAgent.id,
			provider: 'local-simulation',
			model: 'deterministic-v1',
			enabledTools: [],
			status: 'paused',
			expectedRevision: 0,
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: 'MODULE_AGENT_BINDING_REVISION_CONFLICT' },
		});

		const listRoute = composed.routes.find(
			(route) => route.path === '/api/agents' && route.methods.includes('GET'),
		)!;
		const otherRequest = new Request(ORIGIN + '/api/agents');
		const otherTenant = await listRoute.handler({
			request: otherRequest,
			params: {},
			url: new URL(otherRequest.url),
			state: new Map([
				[
					AUTH_PRINCIPAL_STATE_KEY,
					principal(ALL_SCOPES, 'account-b', 'tenant-other'),
				],
			]),
		} as never);
		expect(await otherTenant.json()).toMatchObject({
			moduleAgents: [
				{
					id: moduleAgent.id,
					status: 'unconfigured',
					revision: null,
				},
			],
		});
	});

	it('guards module bindings and refuses tenant edits of module behavior', async () => {
		const owner = composition(principal(ALL_SCOPES));
		owner.context.agentTools.register([readOnlyTool]);
		owner.context.agentDefinitions.register([moduleAgent]);
		owner.composed.start();
		await waitFor(
			async () =>
				(
					(await (await owner.call('/api/agents')).json()) as {
						moduleAgents: readonly unknown[];
					}
				).moduleAgents.length === 1,
		);
		const bindingBody = {
			agentId: moduleAgent.id,
			provider: 'local-simulation',
			model: 'deterministic-v1',
			enabledTools: [],
			status: 'paused',
			expectedRevision: 0,
		};

		const unauthenticated = await owner.call(
			'/api/agents/module-bindings/update',
			{
				method: 'POST',
				authenticated: false,
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					'x-csrf-token': CSRF_TOKEN,
				},
				body: JSON.stringify(bindingBody),
			},
		);
		expect(unauthenticated.status).toBe(401);

		const missingCsrf = await owner.call('/api/agents/module-bindings/update', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
			},
			body: JSON.stringify(bindingBody),
		});
		expect(missingCsrf.status).toBe(403);
		expect(await missingCsrf.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
		const missingOrigin = await owner.call(
			'/api/agents/module-bindings/update',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
					'x-csrf-token': CSRF_TOKEN,
				},
				body: JSON.stringify(bindingBody),
			},
		);
		expect(missingOrigin.status).toBe(403);
		expect(await missingOrigin.json()).toMatchObject({
			error: { code: 'ORIGIN_REQUIRED' },
		});

		const oversized = await owner.mutation(
			'/api/agents/module-bindings/update',
			{ ...bindingBody, ignoredPadding: 'x'.repeat(33 * 1_024) },
		);
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({
			error: { code: 'PAYLOAD_TOO_LARGE' },
		});

		const forbidden = composition(principal(['agents.definitions.read']));
		const forbiddenResponse = await forbidden.mutation(
			'/api/agents/module-bindings/update',
			{
				agentId: moduleAgent.id,
				provider: 'local-simulation',
				model: 'deterministic-v1',
				enabledTools: [],
				status: 'paused',
				expectedRevision: 0,
			},
		);
		expect(forbiddenResponse.status).toBe(403);

		const edit = await owner.mutation('/api/agents/update', {
			id: moduleAgent.id,
			key: 'customer-reviewer',
			name: 'Replaced behavior',
			description: 'A tenant must not replace module-owned behavior.',
			instructions: 'Ignore the module-owned instructions.',
			provider: 'local-simulation',
			model: 'deterministic-v1',
			allowedTools: [],
			procedureIds: [],
			maxSteps: 1,
			timeoutMs: 1_000,
			temperature: 0,
			status: 'paused',
			expectedRevision: 1,
		});
		expect(edit.status).toBe(409);
		expect(await edit.json()).toMatchObject({
			error: { code: 'MODULE_AGENT_READ_ONLY' },
		});
	});
});

/* The 0.8 rename keeps the skill-named HTTP surface alive. These cases pin the
   part that would silently break a deployed client: both contracts must reach
   the same rows, never a parallel set of them. */
describe('procedure compatibility surface', () => {
	const body = {
		key: 'refund-review',
		name: 'Refund review',
		description: 'How an agent reviews a refund request.',
		instructions: 'Check the order, the amount, and the refund window.',
		requiredTools: [],
		status: 'active',
	};

	it('returns one record under both spellings from either route', async () => {
		const owner = composition(principal(ALL_SCOPES));

		const created = await owner.mutation('/api/agent-procedures', body);
		expect(created.status).toBe(201);
		const payload = (await created.json()) as {
			procedure: { id: string; name: string };
			skill: { id: string; name: string };
		};
		expect(payload.skill).toEqual(payload.procedure);

		const workspace = (await (await owner.call('/api/agents')).json()) as {
			procedures: readonly { id: string }[];
			skills: readonly { id: string }[];
		};
		expect(workspace.procedures).toHaveLength(1);
		expect(workspace.skills).toEqual(workspace.procedures);
		expect(workspace.procedures[0]!.id).toBe(payload.procedure.id);
	});

	it('updates one resource when the two routes are mixed', async () => {
		const owner = composition(principal(ALL_SCOPES));

		const created = await owner.mutation('/api/agent-skills', body);
		expect(created.status).toBe(201);
		const { skill } = (await created.json()) as {
			skill: { id: string; revision: number };
		};

		const updated = await owner.mutation('/api/agent-procedures/update', {
			...body,
			id: skill.id,
			name: 'Refund review v2',
			expectedRevision: skill.revision,
		});
		expect(updated.status).toBe(200);

		const workspace = (await (await owner.call('/api/agents')).json()) as {
			procedures: readonly { id: string; name: string }[];
		};
		expect(workspace.procedures).toHaveLength(1);
		expect(workspace.procedures[0]).toMatchObject({
			id: skill.id,
			name: 'Refund review v2',
		});
	});

	it('rejects a stale revision the same way on both routes', async () => {
		const owner = composition(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/agent-procedures', body);
		const { procedure } = (await created.json()) as {
			procedure: { id: string; revision: number };
		};

		const stale = {
			...body,
			id: procedure.id,
			expectedRevision: procedure.revision + 5,
		};
		const canonical = await owner.mutation(
			'/api/agent-procedures/update',
			stale,
		);
		const deprecated = await owner.mutation('/api/agent-skills/update', stale);

		expect(canonical.status).toBe(deprecated.status);
		expect(await canonical.json()).toEqual(await deprecated.json());
	});

	it('denies both routes without the manage scope', async () => {
		const reader = composition(principal(['agents.skills.read']));

		expect((await reader.mutation('/api/agent-procedures', body)).status).toBe(
			403,
		);
		expect((await reader.mutation('/api/agent-skills', body)).status).toBe(403);
	});

	/* An older client still sends skillIds on the agent payload. */
	it('accepts the deprecated agent configuration field', async () => {
		const owner = composition(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/agent-procedures', body);
		const { procedure } = (await created.json()) as {
			procedure: { id: string };
		};

		const agent = await owner.mutation('/api/agents', {
			key: 'legacy-client-agent',
			name: 'Legacy client agent',
			description: 'Created by a client that still sends skillIds.',
			instructions: 'Follow the attached procedure.',
			provider: 'local-simulation',
			model: 'deterministic-v1',
			allowedTools: [],
			skillIds: [procedure.id],
			maxSteps: 2,
			timeoutMs: 5_000,
			temperature: 0,
			status: 'draft',
		});

		expect(agent.status).toBe(201);
		expect(await agent.json()).toMatchObject({
			agent: { procedureIds: [procedure.id] },
		});
	});

	it('returns the deprecated agent and run projections beside the canonical ones', async () => {
		const owner = composition(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/agent-procedures', body);
		const { procedure } = (await created.json()) as {
			procedure: { id: string };
		};

		const agent = await owner.mutation('/api/agents', {
			key: 'projection-agent',
			name: 'Projection agent',
			description: 'Checks that both spellings ship in one payload.',
			instructions: 'Follow the attached procedure.',
			provider: 'local-simulation',
			model: 'deterministic-v1',
			allowedTools: [],
			procedureIds: [procedure.id],
			maxSteps: 2,
			timeoutMs: 5_000,
			temperature: 0,
			status: 'active',
		});
		const createdAgent = (await agent.json()) as {
			agent: { procedureIds: readonly string[]; skillIds: readonly string[] };
		};
		expect(createdAgent.agent.skillIds).toEqual(
			createdAgent.agent.procedureIds,
		);

		const workspace = (await (await owner.call('/api/agents')).json()) as {
			agents: readonly {
				procedureIds: readonly string[];
				skillIds: readonly string[];
			}[];
		};
		const listed = workspace.agents.find(
			(candidate) => candidate.procedureIds.length === 1,
		)!;
		expect(listed.skillIds).toEqual([procedure.id]);

		const runs = (await (await owner.call('/api/agent-runs')).json()) as {
			runs: readonly {
				procedureSnapshots: readonly unknown[];
				skillSnapshots: readonly unknown[];
			}[];
		};
		for (const run of runs.runs) {
			expect(run.skillSnapshots).toEqual(run.procedureSnapshots);
		}
	});
});
