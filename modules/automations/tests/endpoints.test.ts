import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@coreloom/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@coreloom/module-auth/server';
import type { AgentRunQueue } from '@coreloom/module-agents/server';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createAutomationsRoutes } from '../src/api/endpoints.ts';
import { createAutomationsRuntime } from '../src/server/runtime.ts';
import { createAutomationTargetRegistry } from '../src/server/targets.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import { SqliteAutomationsRepository } from '../src/services/sqlite-repository.ts';

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

const ALL_SCOPES = Object.values(AUTOMATIONS_PERMISSIONS);

function fixture(session: AuthPrincipal | null) {
	const runs = new Map<string, { readonly id: string }>();
	const queue: AgentRunQueue = {
		listAgents: (tenantId) => [
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
		list: (context) =>
			context.permissionSnapshot.includes('workflow.allowed')
				? [{ key: 'party-review', label: 'Party review', revision: 2 }]
				: [],
		validate: (targetKey, context) => {
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
		databasePath: ':memory:',
		runQueue: () => queue,
		repository: new SqliteAutomationsRepository(':memory:'),
		secretVault: new AesGcmSecretVault(Buffer.alloc(32, 4)),
		targets,
	});
	const routes = createAutomationsRoutes(authRuntime(session), runtime);
	const route = (path: string, method: string) => {
		const found = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(method),
		);
		if (!found) throw new Error(`Route ${method} ${path} is missing.`);
		return found;
	};
	const invoke = (
		path: string,
		requestPath: string,
		init: RequestInit & {
			readonly authenticated?: boolean;
			readonly params?: Record<string, string>;
			readonly as?: AuthPrincipal;
		} = {},
	) => {
		const { authenticated = true, params = {}, as, ...requestInit } = init;
		const request = new Request(ORIGIN + requestPath, requestInit);
		const state = new Map<string, unknown>();
		const identity = as ?? session;
		if (authenticated && identity) {
			state.set(AUTH_PRINCIPAL_STATE_KEY, identity);
		}
		return route(path, requestInit.method ?? 'GET').handler({
			request,
			params,
			url: new URL(request.url),
			state,
		} as never);
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
		const anonymous = fixture(null);
		expect(
			(
				await anonymous.call('/api/automations/schedules', {
					authenticated: false,
				})
			).status,
		).toBe(401);
		const forbidden = fixture(principal(['agents.runs.read']));
		expect((await forbidden.call('/api/automations/schedules')).status).toBe(
			403,
		);
		expect((await forbidden.call('/api/automations/triggers')).status).toBe(
			403,
		);
	});

	it('denies mutations without manage scope or a valid CSRF token', async () => {
		const reader = fixture(
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

		const owner = fixture(principal(ALL_SCOPES));
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
		const owner = fixture(principal(ALL_SCOPES));
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
		).json()) as { schedules: readonly { id: string }[] };
		expect(listed.schedules.map((entry) => entry.id)).toEqual([schedule.id]);

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

	it('does not expose agent tool grants through the schedule endpoint', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const response = await owner.call('/api/automations/schedules');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			agents: readonly Record<string, unknown>[];
		};
		expect(body.agents).toEqual([
			{
				id: 'tenant-http-agent',
				name: 'Workspace agent',
				status: 'active',
			},
		]);
		expect(body.agents[0]).not.toHaveProperty('allowedTools');
	});

	it('lists and configures workflow targets only from trusted principal scopes', async () => {
		const authorized = fixture(principal([...ALL_SCOPES, 'workflow.allowed']));
		const options = (await (
			await authorized.call('/api/automations/schedules')
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

		const denied = fixture(principal(ALL_SCOPES));
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
