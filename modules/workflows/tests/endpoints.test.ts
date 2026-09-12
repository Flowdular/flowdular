import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { createPlatformCapabilityRegistry } from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createWorkflowsRoutes } from '../src/api/endpoints.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import { WORKFLOW_LIMITS } from '../src/domain/types.ts';
import type { WorkflowsRuntime } from '../src/server/runtime.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';
import { openHttpHarness, type HttpHarness } from './support/harness.ts';

function principal(
	scopes: readonly string[],
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

const graph: WorkflowGraphV1 = {
	schemaVersion: 1,
	nodes: [
		{
			id: 'input.start',
			label: 'Input',
			type: 'input',
			inputPorts: [],
			outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
		},
		{
			id: 'output.done',
			label: 'Output',
			type: 'output',
			inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
			outputPorts: [],
		},
	],
	edges: [
		{
			id: 'edge.done',
			source: { nodeId: 'input.start', port: 'data' },
			target: { nodeId: 'output.done', port: 'input' },
		},
	],
	schemas: {
		'schema.data': {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' } },
		},
	},
	layout: {
		'input.start': { x: 0, y: 0 },
		'output.done': { x: 300, y: 0 },
	},
};

function longLinearGraph(intermediateNodes = 30): WorkflowGraphV1 {
	const nodes: WorkflowGraphV1['nodes'][number][] = [
		{
			id: 'input.start',
			label: 'Input',
			type: 'input',
			inputPorts: [],
			outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
		},
	];
	const edges: WorkflowGraphV1['edges'][number][] = [];
	const layout: Record<string, { readonly x: number; readonly y: number }> = {
		'input.start': { x: 0, y: 0 },
	};
	let sourceNodeId = 'input.start';
	for (let index = 0; index < intermediateNodes; index += 1) {
		const nodeId = `merge.step-${index}`;
		nodes.push({
			id: nodeId,
			label: `Step ${index}`,
			type: 'merge',
			mode: 'all',
			inputPorts: [{ name: 'items', schemaId: 'schema.data' }],
			outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
		});
		edges.push({
			id: `edge.step-${index}`,
			source: { nodeId: sourceNodeId, port: 'data' },
			target: { nodeId, port: 'items' },
		});
		layout[nodeId] = { x: (index + 1) * 200, y: 0 };
		sourceNodeId = nodeId;
	}
	nodes.push({
		id: 'output.done',
		label: 'Output',
		type: 'output',
		inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
		outputPorts: [],
	});
	edges.push({
		id: 'edge.done',
		source: { nodeId: sourceNodeId, port: 'data' },
		target: { nodeId: 'output.done', port: 'input' },
	});
	layout['output.done'] = { x: (intermediateNodes + 1) * 200, y: 0 };
	return {
		schemaVersion: 1,
		nodes,
		edges,
		schemas: { 'schema.data': { type: 'array' } },
		layout,
	};
}

function executionCapabilities() {
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

async function createPublishedDirectWorkflow(
	runtime: WorkflowsRuntime,
	key: string,
) {
	const service = await runtime.service();
	const created = await service.create(
		'tenant-a',
		{ key, name: key, description: '' },
		{ kind: 'user', id: 'account-a', label: 'Owner' },
	);
	await service.update(
		'tenant-a',
		{
			workflowId: created.definition.id,
			expectedRevision: 1,
			name: key,
			description: '',
			graph,
		},
		{ kind: 'user', id: 'account-a', label: 'Owner' },
	);
	await service.publish(
		'tenant-a',
		created.definition.id,
		2,
		{ kind: 'user', id: 'account-a', label: 'Owner' },
		[
			WORKFLOWS_PERMISSIONS.runsExecute,
			'agents.definitions.read',
			'agents.runs.read',
			'agents.runs.execute',
		],
	);
	return created;
}

function route(
	routes: ReturnType<typeof createWorkflowsRoutes>,
	path: string,
	method: 'GET' | 'POST',
) {
	const found = routes.find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes(method),
	);
	if (!found) throw new Error(`Missing ${method} ${path}.`);
	return found;
}

function context(request: Request, identity?: AuthPrincipal) {
	const state = new Map<string, unknown>();
	if (identity) state.set(AUTH_PRINCIPAL_STATE_KEY, identity);
	return {
		request,
		url: new URL(request.url),
		state,
	} as never;
}

describe('workflow HTTP boundary', () => {
	it('declares trusted identity and denies every route before its handler', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 21),
			cursorKey: Buffer.alloc(32, 22),
		});
		const routes = createWorkflowsRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			runtime,
		);
		for (const route of routes) {
			const method = route.methods.includes('GET') ? 'GET' : 'POST';
			const request = new Request(`https://erp.example${route.path}`, {
				method,
				...(method === 'POST'
					? { headers: { 'content-type': 'application/json' }, body: '{}' }
					: {}),
			});
			expect(
				(await route.handler(context(request))).status,
				`${method} ${route.path} anonymous`,
			).toBe(401);
			expect(
				(await route.handler(context(request, principal([])))).status,
				`${method} ${route.path} unscoped`,
			).toBe(403);
		}
		await runtime.dispose();
	});

	it('keeps definition, run, and audit reads inside the authenticated tenant', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 23),
			cursorKey: Buffer.alloc(32, 24),
		});
		const service = await runtime.service();
		const created = await service.create(
			'tenant-a',
			{ key: 'tenant-bound', name: 'Tenant bound', description: '' },
			{ kind: 'user', id: 'account-a', label: 'Owner' },
		);
		await service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Tenant bound',
				description: '',
				graph,
			},
			{ kind: 'user', id: 'account-a', label: 'Owner' },
		);
		const run = await service.simulate(
			{
				workflowId: created.definition.id,
				input: { name: 'Ada' },
				fixtures: [],
			},
			{
				tenantId: 'tenant-a',
				actor: { kind: 'user', id: 'account-a', label: 'Owner' },
				origin: { kind: 'manual' },
				permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
			},
		);
		const routes = createWorkflowsRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			runtime,
		);
		const other = principal(
			[WORKFLOWS_PERMISSIONS.read, WORKFLOWS_PERMISSIONS.runsRead],
			'tenant-b',
		);

		const definitions = await (
			await route(routes, '/api/workflows', 'GET')
		).handler(context(new Request('https://erp.example/api/workflows'), other));
		expect(await definitions.json()).toEqual({ definitions: [] });
		const foreignDefinition = await (
			await route(routes, '/api/workflows/detail', 'GET')
		).handler(
			context(
				new Request(
					`https://erp.example/api/workflows/detail?id=${created.definition.id}`,
				),
				other,
			),
		);
		expect(foreignDefinition.status).toBe(404);
		const runs = await (
			await route(routes, '/api/workflow-runs', 'GET')
		).handler(
			context(new Request('https://erp.example/api/workflow-runs'), other),
		);
		expect(await runs.json()).toEqual({ runs: [], nextCursor: null });
		const foreignRun = await (
			await route(routes, '/api/workflow-runs/detail', 'GET')
		).handler(
			context(
				new Request(
					`https://erp.example/api/workflow-runs/detail?id=${run.run.id}`,
				),
				other,
			),
		);
		expect(foreignRun.status).toBe(404);
		const audit = await (
			await route(routes, '/api/workflow-audit', 'GET')
		).handler(
			context(new Request('https://erp.example/api/workflow-audit'), other),
		);
		expect(await audit.json()).toEqual({ events: [], nextCursor: null });
		await runtime.dispose();
	});

	it('resumes a terminal event stream at its final sequence and closes cleanly', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 25),
			cursorKey: Buffer.alloc(32, 26),
		});
		const service = await runtime.service();
		const created = await service.create(
			'tenant-a',
			{ key: 'terminal-stream', name: 'Terminal stream', description: '' },
			{ kind: 'user', id: 'account-a', label: 'Owner' },
		);
		await service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Terminal stream',
				description: '',
				graph,
			},
			{ kind: 'user', id: 'account-a', label: 'Owner' },
		);
		const run = await service.simulate(
			{
				workflowId: created.definition.id,
				input: { name: 'Ada' },
				fixtures: [],
			},
			{
				tenantId: 'tenant-a',
				actor: { kind: 'user', id: 'account-a', label: 'Owner' },
				origin: { kind: 'manual' },
				permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
			},
		);
		const lastSequence = run.events.at(-1)!.sequence;
		const routes = createWorkflowsRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			runtime,
		);
		const response = await (
			await route(routes, '/api/workflow-runs/events', 'GET')
		).handler(
			context(
				new Request(
					`https://erp.example/api/workflow-runs/events?runId=${run.run.id}&afterSequence=${lastSequence}`,
				),
				principal([WORKFLOWS_PERMISSIONS.runsRead]),
			),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('event: workflow.stream-complete');
		expect(
			(await service.getRunDetail('tenant-a', run.run.id)).events,
		).toHaveLength(lastSequence);
		await runtime.dispose();
	});

	it('emits cursor-free heartbeats and flushes terminal events before closing', async () => {
		// Advance the heartbeat clock without freezing PostgreSQL socket timers.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
		const runtime = createWorkflowsTestRuntime({
			capabilities: executionCapabilities(),
			payloadKey: Buffer.alloc(32, 29),
			cursorKey: Buffer.alloc(32, 30),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		try {
			await createPublishedDirectWorkflow(runtime, 'heartbeat-stream');
			const service = await runtime.service();
			const accepted = await service.enqueue(
				{
					workflowKey: 'heartbeat-stream',
					input: { name: 'Ada' },
					idempotencyKey: 'heartbeat-stream:1',
				},
				{
					tenantId: 'tenant-a',
					actor: { kind: 'user', id: 'account-a', label: 'Owner' },
					origin: { kind: 'manual' },
					permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
				},
			);
			const initialSequence = (
				await service.getRunDetail('tenant-a', accepted.runId)
			).events.at(-1)!.sequence;
			const routes = createWorkflowsRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				runtime,
			);
			const response = await (
				await route(routes, '/api/workflow-runs/events', 'GET')
			).handler(
				context(
					new Request(
						`https://erp.example/api/workflow-runs/events?runId=${accepted.runId}&afterSequence=${initialSequence}`,
					),
					principal([WORKFLOWS_PERMISSIONS.runsRead]),
				),
			);
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let streamed = decoder.decode((await reader.read()).value);
			expect(streamed).toBe('retry: 1000\n\n');

			await vi.advanceTimersByTimeAsync(15_000);
			const heartbeat = decoder.decode((await reader.read()).value);
			streamed += heartbeat;
			expect(heartbeat).toContain('event: workflow.heartbeat');
			expect(heartbeat).not.toContain('id:');

			await service.cancel('tenant-a', accepted.runId, {
				kind: 'user',
				id: 'account-a',
				label: 'Owner',
			});
			runtime.start();
			await vi.advanceTimersByTimeAsync(1_000);
			for (let index = 0; index < 20; index += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
				streamed += decoder.decode(chunk.value);
			}
			expect(streamed).toContain('"type":"run.cancel.requested"');
			expect(streamed).toContain('"type":"run.cancelled"');
			expect(streamed.indexOf('"type":"run.cancelled"')).toBeLessThan(
				streamed.indexOf('event: workflow.stream-complete'),
			);
			const firstEventCursor = streamed.match(/id: ([^\n]+)\ndata:/)?.[1];
			expect(firstEventCursor).toBeDefined();
			expect(
				await service.eventSequence(
					'tenant-a',
					accepted.runId,
					firstEventCursor!,
				),
			).toBe(initialSequence + 1);
		} finally {
			await Promise.resolve(runtime.dispose());
			vi.useRealTimers();
		}
	});

	it('emits a replay boundary and resumes until the terminal event is flushed', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 31),
			cursorKey: Buffer.alloc(32, 32),
		});
		try {
			const service = await runtime.service();
			const created = await service.create(
				'tenant-a',
				{ key: 'replay-boundary', name: 'Replay boundary', description: '' },
				{ kind: 'user', id: 'account-a', label: 'Owner' },
			);
			await service.update(
				'tenant-a',
				{
					workflowId: created.definition.id,
					expectedRevision: 1,
					name: 'Replay boundary',
					description: '',
					graph: longLinearGraph(),
				},
				{ kind: 'user', id: 'account-a', label: 'Owner' },
			);
			const run = await service.simulate(
				{
					workflowId: created.definition.id,
					input: [],
					fixtures: [],
				},
				{
					tenantId: 'tenant-a',
					actor: { kind: 'user', id: 'account-a', label: 'Owner' },
					origin: { kind: 'manual' },
					permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
				},
			);
			expect(run.events.length).toBeGreaterThan(
				WORKFLOW_LIMITS.maxReplayEvents,
			);
			const routes = createWorkflowsRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				runtime,
			);
			const response = await (
				await route(routes, '/api/workflow-runs/events', 'GET')
			).handler(
				context(
					new Request(
						`https://erp.example/api/workflow-runs/events?runId=${run.run.id}`,
					),
					principal([WORKFLOWS_PERMISSIONS.runsRead]),
				),
			);
			const streamed = await response.text();
			expect(streamed).toContain('event: workflow.replay-boundary');
			expect(streamed).toContain('"type":"run.succeeded"');
			expect(streamed.indexOf('event: workflow.replay-boundary')).toBeLessThan(
				streamed.indexOf('"type":"run.succeeded"'),
			);
			expect(streamed.indexOf('"type":"run.succeeded"')).toBeLessThan(
				streamed.indexOf('event: workflow.stream-complete'),
			);
			const boundary = streamed.match(
				/event: workflow\.replay-boundary\ndata: \{"cursor":"([^"]+)"\}/,
			)?.[1];
			expect(boundary).toBeDefined();
			expect(
				await service.eventSequence('tenant-a', run.run.id, boundary!),
			).toBe(WORKFLOW_LIMITS.maxReplayEvents);
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses invalid page limits and conflicting event cursors', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 27),
			cursorKey: Buffer.alloc(32, 28),
		});
		const routes = createWorkflowsRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			runtime,
		);
		const identity = principal([WORKFLOWS_PERMISSIONS.runsRead]);
		const invalidLimit = await (
			await route(routes, '/api/workflow-runs', 'GET')
		).handler(
			context(
				new Request('https://erp.example/api/workflow-runs?limit=0'),
				identity,
			),
		);
		expect(invalidLimit.status).toBe(400);
		const conflicting = await (
			await route(routes, '/api/workflow-runs/events', 'GET')
		).handler(
			context(
				new Request(
					'https://erp.example/api/workflow-runs/events?runId=missing&afterSequence=1',
					{
						headers: {
							'last-event-id': (await runtime.service()).eventCursor(
								'tenant-a',
								'missing',
								2,
							),
						},
					},
				),
				identity,
			),
		);
		expect(conflicting.status).toBe(409);
		await runtime.dispose();
	});
});

async function waitFor(
	predicate: () => Promise<boolean>,
	timeout = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for workflow state.');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('workflow write routes with a browser session', () => {
	async function createDefinition(harness: HttpHarness, key: string) {
		const created = await harness.mutation('/api/workflows', {
			key,
			name: `Flow ${key}`,
			description: '',
		});
		expect(created.status).toBe(201);
		return (await created.json()).definition as { id: string };
	}

	async function publishDirect(harness: HttpHarness, key: string) {
		const definition = await createDefinition(harness, key);
		const updated = await harness.mutation('/api/workflows/update', {
			workflowId: definition.id,
			expectedRevision: 1,
			name: `Flow ${key}`,
			description: '',
			graph,
		});
		expect(updated.status).toBe(200);
		const published = await harness.mutation('/api/workflows/publish', {
			workflowId: definition.id,
			expectedRevision: 2,
		});
		expect(published.status).toBe(200);
		return definition;
	}

	it('creates, updates, validates and publishes a definition that reads back pinned', async () => {
		const harness = openHttpHarness({
			payloadKey: Buffer.alloc(32, 41),
			cursorKey: Buffer.alloc(32, 42),
		});
		try {
			const created = await harness.mutation('/api/workflows', {
				key: 'session-create',
				name: 'Session create',
				description: 'Created over HTTP',
			});
			expect(created.status).toBe(201);
			const { definition } = await created.json();
			expect(definition).toMatchObject({
				key: 'session-create',
				currentDraftRevision: 1,
				publishedRevision: null,
			});
			const listed = await harness.call('/api/workflows');
			expect(
				(await listed.json()).definitions.map(
					(entry: { id: string }) => entry.id,
				),
			).toEqual([definition.id]);

			const updated = await harness.mutation('/api/workflows/update', {
				workflowId: definition.id,
				expectedRevision: 1,
				name: 'Session updated',
				description: 'Updated over HTTP',
				graph,
			});
			expect(updated.status).toBe(200);
			expect((await updated.json()).detail.definition).toMatchObject({
				name: 'Session updated',
				currentDraftRevision: 2,
			});

			const validated = await harness.mutation('/api/workflows/validate', {
				graph,
			});
			expect(validated.status).toBe(200);
			expect((await validated.json()).report.valid).toBe(true);

			const published = await harness.mutation('/api/workflows/publish', {
				workflowId: definition.id,
				expectedRevision: 2,
			});
			expect(published.status).toBe(200);
			expect((await published.json()).detail.definition.publishedRevision).toBe(
				2,
			);
			const detail = await harness.call(
				`/api/workflows/detail?id=${definition.id}`,
			);
			expect(detail.status).toBe(200);
			const read = (await detail.json()).detail;
			expect(read.definition).toMatchObject({
				name: 'Session updated',
				description: 'Updated over HTTP',
				publishedRevision: 2,
			});
			expect(read.draft.graph).toEqual(graph);
		} finally {
			await harness.dispose();
		}
	});

	it('archives a definition and deletes an unpublished one', async () => {
		const harness = openHttpHarness({
			payloadKey: Buffer.alloc(32, 43),
			cursorKey: Buffer.alloc(32, 44),
		});
		try {
			const archived = await createDefinition(harness, 'session-archive');
			const archive = await harness.mutation('/api/workflows/archive', {
				workflowId: archived.id,
			});
			expect(archive.status).toBe(200);
			expect((await archive.json()).definition.status).toBe('archived');
			const detail = await harness.call(
				`/api/workflows/detail?id=${archived.id}`,
			);
			expect((await detail.json()).detail.definition.status).toBe('archived');

			const removed = await createDefinition(harness, 'session-delete');
			const remove = await harness.mutation('/api/workflows/delete', {
				workflowId: removed.id,
			});
			expect(remove.status).toBe(200);
			expect(await remove.json()).toEqual({ deleted: true });
			expect(
				(await harness.call(`/api/workflows/detail?id=${removed.id}`)).status,
			).toBe(404);
			expect(
				(await (await harness.call('/api/workflows')).json()).definitions.map(
					(entry: { id: string }) => entry.id,
				),
			).toEqual([archived.id]);
		} finally {
			await harness.dispose();
		}
	});

	it('simulates, enqueues, cancels and retries a run through the session', async () => {
		const harness = openHttpHarness({
			payloadKey: Buffer.alloc(32, 45),
			cursorKey: Buffer.alloc(32, 46),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		try {
			const definition = await publishDirect(harness, 'session-runs');

			const simulated = await harness.mutation('/api/workflow-runs/simulate', {
				workflowId: definition.id,
				input: { name: 'Ada' },
				fixtures: [],
			});
			expect(simulated.status).toBe(200);
			const simulation = (await simulated.json()).run;
			expect(simulation.run).toMatchObject({
				mode: 'simulate',
				status: 'succeeded',
			});
			const simulationDetail = await harness.call(
				`/api/workflow-runs/detail?id=${simulation.run.id}`,
			);
			expect((await simulationDetail.json()).run.status).toBe('succeeded');

			const enqueued = await harness.mutation('/api/workflow-runs', {
				workflowKey: 'session-runs',
				input: { name: 'Ada' },
				idempotencyKey: 'session-runs:1',
			});
			expect(enqueued.status).toBe(202);
			const { accepted } = await enqueued.json();
			expect(accepted).toMatchObject({
				workflowId: definition.id,
				workflowRevision: 2,
				status: 'queued',
				created: true,
			});
			const listed = await harness.call('/api/workflow-runs?mode=live');
			expect(
				(await listed.json()).runs.map((entry: { id: string }) => entry.id),
			).toEqual([accepted.runId]);

			const cancelled = await harness.mutation('/api/workflow-runs/cancel', {
				runId: accepted.runId,
			});
			expect(cancelled.status).toBe(200);
			expect(await cancelled.json()).toEqual({
				runId: accepted.runId,
				status: 'cancel-requested',
				requested: true,
			});
			harness.runtime.start();
			await waitFor(
				async () =>
					(
						await (
							await harness.call(
								`/api/workflow-runs/detail?id=${accepted.runId}`,
							)
						).json()
					).run.status === 'cancelled',
			);

			const retried = await harness.mutation('/api/workflow-runs/retry', {
				runId: accepted.runId,
			});
			expect(retried.status).toBe(200);
			const retry = await retried.json();
			expect(retry).toMatchObject({
				workflowId: definition.id,
				workflowRevision: 2,
				status: 'queued',
			});
			expect(retry.runId).not.toBe(accepted.runId);
			const afterRetry = await harness.call(
				`/api/workflow-runs?workflowId=${definition.id}&mode=live`,
			);
			expect(
				(await afterRetry.json()).runs
					.map((entry: { id: string }) => entry.id)
					.sort(),
			).toEqual([accepted.runId, retry.runId].sort());
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a mutation whose CSRF token does not match the session', async () => {
		const harness = openHttpHarness({
			payloadKey: Buffer.alloc(32, 47),
			cursorKey: Buffer.alloc(32, 48),
		});
		try {
			const response = await harness.mutation(
				'/api/workflows',
				{ key: 'session-csrf', name: 'Session CSRF', description: '' },
				{ csrfToken: 'wrong' },
			);
			expect(response.status).toBe(403);
			expect((await response.json()).error.code).toBe('CSRF_REJECTED');
			expect(
				(await (await harness.call('/api/workflows')).json()).definitions,
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});
});
