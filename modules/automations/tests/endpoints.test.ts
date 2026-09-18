import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createAutomationsRoutes } from '../src/api/endpoints.ts';
import { createAutomationsRuntime } from '../src/server/runtime.ts';
import { createAutomationTargetRegistry } from '../src/server/targets.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

function principal(
	scopes: readonly string[],
	tenantId = 'tenant-http',
): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId,
		email: 'account-a@example.com',
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
			const principal = token === null ? undefined : sessions.get(token);
			return principal
				? { principal, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null;
		},
		resolveApiTokenIdentity: async () => null,
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

const ALL_SCOPES = Object.values(AUTOMATIONS_PERMISSIONS);

/* Starting the embedded engine costs about half a second, so the file shares
   one and empties it between cases. Fixtures inside one test deliberately share
   the store: they differ only in the principal that calls the routes. */
let shared: AutomationsTestDatabase;

beforeAll(async () => {
	shared = await openAutomationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function fixture(session: AuthPrincipal | null) {
	const runs = new Map<string, { readonly id: string }>();
	const queue: AgentRunQueue = {
		listAgents: async (tenantId) => [
			{
				id: tenantId + '-agent',
				name: 'Workspace agent',
				status: 'active',
				allowedTools: [],
				revision: 1,
				ownership: { kind: 'tenant' },
			},
		],
		enqueue: async (_context, input) => {
			const key = input.idempotencyKey ?? 'run:' + runs.size;
			const existing = runs.get(key);
			if (existing) return existing as never;
			const created = { id: 'run-' + (runs.size + 1) };
			runs.set(key, created);
			return created as never;
		},
		enqueueWithOutcome: async (context, input) => {
			const key = input.idempotencyKey ?? 'run:' + runs.size;
			const created = !runs.has(key);
			return {
				run: await queue.enqueue(context, input),
				created,
			};
		},
	};
	const targets = createAutomationTargetRegistry();
	targets.register({
		kind: 'workflow',
		contractVersion: 1,
		available: () => true,
		list: async (context) =>
			context.permissionSnapshot.includes('workflow.allowed')
				? [{ key: 'party-review', label: 'Party review', revision: 2 }]
				: [],
		validate: async (targetKey, context) => {
			if (!context.permissionSnapshot.includes('workflow.allowed')) {
				throw Object.assign(new Error('Workflow permission denied.'), {
					code: 'WORKFLOW_PERMISSION_DENIED',
					status: 403,
				});
			}
			if (targetKey !== 'party-review') {
				throw Object.assign(new Error('Workflow not found.'), {
					code: 'WORKFLOW_NOT_FOUND',
					status: 404,
				});
			}
			return { key: targetKey, label: 'Party review', revision: 2 };
		},
		invoke: async () => ({
			correlationId: 'workflow-run-1',
			created: true,
			status: 'queued',
		}),
	});
	const runtime = createAutomationsRuntime({
		databases: shared.databases,
		runQueue: () => queue,
		secretVault: new AesGcmSecretVault(Buffer.alloc(32, 4)),
		targets,
	});
	/* One registered token per principal a case signs in as, so `as` reaches the
	   routes the same way a second browser session would. */
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const tokenFor = (identity: AuthPrincipal): string => {
		for (const [token, registered] of sessions) {
			if (registered === identity) return token;
		}
		const token = `session-token-${String(sessions.size + 1).padStart(4, '0')}`;
		sessions.set(token, identity);
		return token;
	};
	const routes = createAutomationsRoutes(auth, runtime);
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
			readonly as?: AuthPrincipal;
		} = {},
	) => {
		const { authenticated = true, params = {}, as, ...requestInit } = init;
		const identity = as ?? session;
		const headers = new Headers(requestInit.headers);
		if (authenticated && identity) {
			headers.set(
				'cookie',
				`coreloom_session_dev=${as ? tokenFor(as) : SESSION_TOKEN}`,
			);
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
				cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
				'x-csrf-token': CSRF_TOKEN,
				...(init.headers as Record<string, string> | undefined),
			},
			body: JSON.stringify(body),
		});
	return { call, mutation };
}

describe('automations HTTP boundary', () => {
	it('denies unauthenticated and under-scoped reads', async () => {
		const anonymous = await fixture(null);
		expect(
			(
				await anonymous.call('/api/automations/schedules', {
					authenticated: false,
				})
			).status,
		).toBe(401);
		const forbidden = await fixture(principal(['agents.runs.read']));
		expect((await forbidden.call('/api/automations/schedules')).status).toBe(
			403,
		);
		expect((await forbidden.call('/api/automations/triggers')).status).toBe(
			403,
		);
	});

	it('denies mutations without manage scope or a valid CSRF token', async () => {
		const reader = await fixture(
			principal([
				AUTOMATIONS_PERMISSIONS.read,
				AUTOMATIONS_PERMISSIONS.triggersRead,
			]),
		);
		expect(
			(await reader.mutation('/api/automations/schedules', { id: 'x' })).status,
		).toBe(403);
		expect(
			(await reader.mutation('/api/automations/triggers', { id: 'x' })).status,
		).toBe(403);

		const owner = await fixture(principal(ALL_SCOPES));
		const noCsrf = await owner.mutation(
			'/api/automations/schedules',
			{ id: 'x' },
			{ headers: { 'x-csrf-token': '' } },
		);
		expect(noCsrf.status).toBe(403);
		expect(await noCsrf.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
	});

	it('creates, lists, and deletes a schedule without crossing tenants', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/automations/schedules', {
			agentId: 'tenant-http-agent',
			label: 'Every ten minutes',
			inputTemplate: 'Summarize the day.',
			cadence: 'every:10',
			enabled: true,
		});
		expect(created.status).toBe(201);
		const schedule = ((await created.json()) as { schedule: { id: string } })
			.schedule;
		const listed = (await (
			await owner.call('/api/automations/schedules')
		).json()) as { items: readonly { id: string }[] };
		expect(listed.items.map((entry) => entry.id)).toEqual([schedule.id]);

		const crossDelete = await owner.mutation(
			'/api/automations/schedules/delete',
			{ id: schedule.id },
			{ as: principal(ALL_SCOPES, 'tenant-other') },
		);
		expect(crossDelete.status).toBe(404);
		expect(
			(
				await owner.mutation('/api/automations/schedules/delete', {
					id: schedule.id,
				})
			).status,
		).toBe(200);
	});

	it('serves the form options apart from the lists without agent tool grants', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		const response = await owner.call('/api/automations/options');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			agents: readonly Record<string, unknown>[];
			targets: readonly Record<string, unknown>[];
			variables: readonly Record<string, unknown>[];
			timeZone: string;
		};
		expect(body.agents).toEqual([
			{
				id: 'tenant-http-agent',
				name: 'Workspace agent',
				status: 'active',
			},
		]);
		expect(body.agents[0]).not.toHaveProperty('allowedTools');
		expect(body.targets).toContainEqual({
			kind: 'agent',
			key: 'tenant-http-agent',
			label: 'Workspace agent',
			available: true,
		});
		expect(body.variables.length).toBeGreaterThan(0);
		expect(body.timeZone).toBe('UTC');

		for (const path of [
			'/api/automations/schedules',
			'/api/automations/triggers',
		]) {
			const list = (await (await owner.call(path)).json()) as Record<
				string,
				unknown
			>;
			expect(Object.keys(list).sort()).toEqual(['items', 'page']);
		}
		const triggerReader = principal([AUTOMATIONS_PERMISSIONS.triggersRead]);
		expect(
			(await owner.call('/api/automations/options', { as: triggerReader }))
				.status,
		).toBe(403);
		const triggerOptions = await owner.call(
			'/api/automations/triggers/options',
			{
				as: triggerReader,
			},
		);
		expect(triggerOptions.status).toBe(200);
		const triggerBody = (await triggerOptions.json()) as Record<
			string,
			unknown
		>;
		expect(Object.keys(triggerBody).sort()).toEqual(['agents', 'targets']);
		expect(triggerBody.agents).toEqual(body.agents);
		expect(triggerBody.targets).toEqual(body.targets);
	});

	interface ListBody {
		readonly items: readonly {
			readonly id: string;
			readonly label: string;
			readonly enabled: boolean;
			readonly updatedAt: number;
		}[];
		readonly page: {
			readonly nextCursor: string | null;
			readonly limit: number;
		};
	}

	async function createSchedules(
		owner: Awaited<ReturnType<typeof fixture>>,
		entries: readonly { readonly label: string; readonly enabled?: boolean }[],
	): Promise<void> {
		for (const entry of entries) {
			const created = await owner.mutation('/api/automations/schedules', {
				agentId: 'tenant-http-agent',
				label: entry.label,
				inputTemplate: 'Run.',
				cadence: 'every:10',
				enabled: entry.enabled ?? true,
			});
			expect(created.status).toBe(201);
		}
	}

	async function list(
		owner: Awaited<ReturnType<typeof fixture>>,
		path: string,
		init: Parameters<Awaited<ReturnType<typeof fixture>>['call']>[1] = {},
	): Promise<ListBody> {
		const response = await owner.call(path, init);
		expect(response.status).toBe(200);
		return (await response.json()) as ListBody;
	}

	it('pages schedules by label with no overlap and no gap', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		await createSchedules(owner, [
			{ label: 'beta digest' },
			{ label: 'Alpha digest' },
			{ label: 'gamma digest' },
			{ label: 'Delta digest', enabled: false },
			{ label: 'epsilon digest' },
		]);
		const first = await list(owner, '/api/automations/schedules?limit=2');
		expect(first.items.map((entry) => entry.label)).toEqual([
			'Alpha digest',
			'beta digest',
		]);
		expect(first.page).toMatchObject({ limit: 2 });
		expect(first.page.nextCursor).not.toBeNull();

		const second = await list(
			owner,
			'/api/automations/schedules?limit=2&cursor=' + first.page.nextCursor,
		);
		expect(second.items.map((entry) => entry.label)).toEqual([
			'Delta digest',
			'epsilon digest',
		]);
		/* A full page may still be the last one; the cursor stops one page later. */
		expect(second.page.nextCursor).not.toBeNull();
		const third = await list(
			owner,
			'/api/automations/schedules?limit=2&cursor=' + second.page.nextCursor,
		);
		expect(third.items.map((entry) => entry.label)).toEqual(['gamma digest']);
		expect(third.page.nextCursor).toBeNull();

		const descending = await list(
			owner,
			'/api/automations/schedules?sort=label&direction=desc&limit=3',
		);
		expect(descending.items.map((entry) => entry.label)).toEqual([
			'gamma digest',
			'epsilon digest',
			'Delta digest',
		]);

		const recent = await list(
			owner,
			'/api/automations/schedules?sort=updatedAt&direction=desc&limit=3',
		);
		const rest = await list(
			owner,
			'/api/automations/schedules?sort=updatedAt&direction=desc&limit=3&cursor=' +
				recent.page.nextCursor,
		);
		const walked = [...recent.items, ...rest.items];
		expect(new Set(walked.map((entry) => entry.id)).size).toBe(5);
		for (let index = 1; index < walked.length; index += 1) {
			expect(walked[index]!.updatedAt).toBeLessThanOrEqual(
				walked[index - 1]!.updatedAt,
			);
		}
	});

	it('filters schedules on the server and binds the cursor to the filters', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		await createSchedules(owner, [
			{ label: 'beta digest' },
			{ label: 'Alpha digest' },
			{ label: 'Delta digest', enabled: false },
			{ label: 'Alpine report' },
		]);
		const enabled = await list(
			owner,
			'/api/automations/schedules?enabled=true&limit=2',
		);
		expect(enabled.items.map((entry) => entry.label)).toEqual([
			'Alpha digest',
			'Alpine report',
		]);
		const enabledRest = await list(
			owner,
			'/api/automations/schedules?enabled=true&limit=2&cursor=' +
				enabled.page.nextCursor,
		);
		expect(enabledRest.items.map((entry) => entry.label)).toEqual([
			'beta digest',
		]);
		const searched = await list(owner, '/api/automations/schedules?q=ALP');
		expect(searched.items.map((entry) => entry.label)).toEqual([
			'Alpha digest',
			'Alpine report',
		]);
		expect(
			(await list(owner, '/api/automations/schedules?q=%25')).items,
		).toEqual([]);

		const stale = await owner.call(
			'/api/automations/schedules?limit=2&cursor=' + enabled.page.nextCursor,
		);
		expect([
			stale.status,
			((await stale.json()) as { error: { code: string } }).error.code,
		]).toEqual([400, 'CURSOR_INVALID']);
		const resorted = await owner.call(
			'/api/automations/schedules?enabled=true&limit=2&sort=updatedAt&cursor=' +
				enabled.page.nextCursor,
		);
		expect(resorted.status).toBe(400);
	});

	it('refuses a cursor it did not sign, a foreign tenant cursor and bad list input', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		await createSchedules(owner, [{ label: 'One' }, { label: 'Two' }]);
		const first = await list(owner, '/api/automations/schedules?limit=1');
		const cursor = first.page.nextCursor!;
		const code = async (response: Response) => [
			response.status,
			((await response.json()) as { error: { code: string } }).error.code,
		];

		expect(
			await code(
				await owner.call('/api/automations/schedules?cursor=c1.abc.def'),
			),
		).toEqual([400, 'CURSOR_INVALID']);
		const [version, body, signature] = cursor.split('.');
		const tampered = `${version}.${body![0] === 'A' ? 'B' : 'A'}${body!.slice(1)}.${signature}`;
		expect(
			await code(
				await owner.call(
					'/api/automations/schedules?limit=1&cursor=' + tampered,
				),
			),
		).toEqual([400, 'CURSOR_INVALID']);
		expect(
			await code(
				await owner.call(
					'/api/automations/schedules?limit=1&cursor=' + cursor,
					{
						as: principal(ALL_SCOPES, 'tenant-other'),
					},
				),
			),
		).toEqual([400, 'CURSOR_INVALID']);

		expect(
			await code(await owner.call('/api/automations/schedules?sort=name')),
		).toEqual([400, 'INVALID_INPUT']);
		expect(
			await code(await owner.call('/api/automations/schedules?direction=up')),
		).toEqual([400, 'INVALID_INPUT']);
		expect(
			await code(await owner.call('/api/automations/schedules?limit=500')),
		).toEqual([400, 'INVALID_INPUT']);
		expect(
			await code(await owner.call('/api/automations/schedules?enabled=maybe')),
		).toEqual([400, 'INVALID_INPUT']);
		expect(
			await code(await owner.call('/api/automations/triggers?sort=name')),
		).toEqual([400, 'INVALID_INPUT']);
	});

	it('pages and filters triggers the same way', async () => {
		const owner = await fixture(principal(ALL_SCOPES));
		for (const entry of [
			{ label: 'beta hook', enabled: true },
			{ label: 'Alpha hook', enabled: false },
			{ label: 'gamma hook', enabled: true },
		]) {
			const created = await owner.mutation('/api/automations/triggers', {
				agentId: 'tenant-http-agent',
				...entry,
			});
			expect(created.status).toBe(201);
		}
		const first = await list(owner, '/api/automations/triggers?limit=2');
		expect(first.items.map((entry) => entry.label)).toEqual([
			'Alpha hook',
			'beta hook',
		]);
		expect(first.page.nextCursor).not.toBeNull();
		const second = await list(
			owner,
			'/api/automations/triggers?limit=2&cursor=' + first.page.nextCursor,
		);
		expect(second.items.map((entry) => entry.label)).toEqual(['gamma hook']);
		expect(second.page.nextCursor).toBeNull();
		expect(
			(await list(owner, '/api/automations/triggers?enabled=true')).items.map(
				(entry) => entry.label,
			),
		).toEqual(['beta hook', 'gamma hook']);
		expect(
			(await list(owner, '/api/automations/triggers?q=gam')).items.map(
				(entry) => entry.label,
			),
		).toEqual(['gamma hook']);
		const foreign = await owner.call(
			'/api/automations/triggers?limit=2&cursor=' + first.page.nextCursor,
			{ as: principal(ALL_SCOPES, 'tenant-other') },
		);
		expect(foreign.status).toBe(400);
	});

	it('lists and configures workflow targets only from trusted principal scopes', async () => {
		const authorized = await fixture(
			principal([...ALL_SCOPES, 'workflow.allowed']),
		);
		const options = (await (
			await authorized.call('/api/automations/options')
		).json()) as {
			targets: readonly Record<string, unknown>[];
		};
		expect(options.targets).toContainEqual({
			kind: 'workflow',
			key: 'party-review',
			label: 'Party review',
			revision: 2,
			available: true,
		});

		const created = await authorized.mutation('/api/automations/schedules', {
			targetKind: 'workflow',
			targetKey: 'party-review',
			label: 'Review parties',
			inputTemplate: '{"partyId":"party-1"}',
			cadence: 'every:10',
			enabled: true,
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			schedule: {
				targetKind: 'workflow',
				targetKey: 'party-review',
				agentId: '',
			},
		});

		const createdTrigger = await authorized.mutation(
			'/api/automations/triggers',
			{
				targetKind: 'workflow',
				targetKey: 'party-review',
				label: 'Review webhook',
				enabled: true,
			},
		);
		expect(createdTrigger.status).toBe(201);
		const trigger = (await createdTrigger.json()) as {
			readonly trigger: { readonly id: string; readonly targetKind: string };
		};
		expect(trigger.trigger.targetKind).toBe('workflow');
		const retargeted = await authorized.mutation(
			'/api/automations/triggers/update',
			{
				id: trigger.trigger.id,
				targetKind: 'agent',
				targetKey: 'tenant-http-agent',
				label: 'Agent webhook',
				enabled: true,
			},
		);
		expect(retargeted.status).toBe(200);
		expect(await retargeted.json()).toMatchObject({
			trigger: {
				targetKind: 'agent',
				targetKey: 'tenant-http-agent',
				agentId: 'tenant-http-agent',
			},
		});

		const denied = await fixture(principal(ALL_SCOPES));
		const refused = await denied.mutation('/api/automations/schedules', {
			targetKind: 'workflow',
			targetKey: 'party-review',
			label: 'Unauthorized workflow',
			inputTemplate: '{}',
			cadence: 'every:10',
			enabled: true,
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({
			error: { code: 'WORKFLOW_PERMISSION_DENIED' },
		});
		const refusedTrigger = await denied.mutation('/api/automations/triggers', {
			targetKind: 'workflow',
			targetKey: 'party-review',
			label: 'Unauthorized webhook',
			enabled: true,
		});
		expect(refusedTrigger.status).toBe(403);
		expect(await refusedTrigger.json()).toMatchObject({
			error: { code: 'WORKFLOW_PERMISSION_DENIED' },
		});
	});
});
