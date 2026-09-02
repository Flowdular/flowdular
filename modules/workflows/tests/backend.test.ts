import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformCapabilityRegistry, userActor } from '@coreloom/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type ActionExecutionResult,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@coreloom/module-agents/server';
import { describe, expect, it } from 'vitest';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { JsonValue, WorkflowGraphV1 } from '../src/domain/types.ts';
import { WORKFLOW_LIMITS } from '../src/domain/types.ts';
import {
	assertProductionWorkflowSecrets,
	createWorkflowsRuntime,
} from '../src/server/runtime.ts';
import { safePayloadEvidence } from '../src/services/payload-codec.ts';
import { createWorkflowPayloadCodec } from '../src/services/payload-codec.ts';
import { createWorkflowCursorCodec } from '../src/services/cursor-codec.ts';
import { WorkflowsService } from '../src/services/workflows-service.ts';
import { SqliteWorkflowsRepository } from '../src/services/sqlite-repository.ts';

const actor = userActor({ accountId: 'owner-1', email: 'owner@example.com' });
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
	WORKFLOWS_PERMISSIONS.runsCancel,
	'agents.definitions.read',
	'agents.runs.read',
	'agents.runs.execute',
];

const schema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
} as const;

function directGraph(): WorkflowGraphV1 {
	return {
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
		schemas: { 'schema.data': schema },
		layout: { 'input.start': { x: 0, y: 0 }, 'output.done': { x: 300, y: 0 } },
	};
}

function agentGraph(): WorkflowGraphV1 {
	return {
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
				id: 'agent.process',
				label: 'Agent',
				type: 'agent',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.data' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				agent: { agentId: 'agent-1', revision: 3 },
				toolGrants: ['catalog.items.read'],
				outputSchemaId: 'schema.data',
				failurePolicy: {
					maxAttempts: 2,
					retryOn: ['PROVIDER_FAILED'],
					backoff: { kind: 'fixed', initialMs: 1, maximumMs: 1 },
					onExhausted: 'fail-run',
				},
			},
			{
				id: 'output.success',
				label: 'Success',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
			{
				id: 'output.failure',
				label: 'Failure',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.error' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.agent',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'agent.process', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'agent.process', port: 'success' },
				target: { nodeId: 'output.success', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'agent.process', port: 'failure' },
				target: { nodeId: 'output.failure', port: 'input' },
			},
		],
		schemas: {
			'schema.data': schema,
			'schema.error': {
				type: 'object',
				required: ['code'],
				properties: { code: { type: 'string' } },
			},
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'agent.process': { x: 250, y: 0 },
			'output.success': { x: 500, y: -100 },
			'output.failure': { x: 500, y: 100 },
		},
	};
}

function actionGraph(
	maxAttempts = 1,
	retryOn: readonly string[] = [],
): WorkflowGraphV1 {
	return {
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
				id: 'action.create',
				label: 'Create',
				type: 'action',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.data' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				action: { actionId: 'catalog.items.create', contractVersion: 1 },
				failurePolicy: {
					maxAttempts,
					retryOn,
					backoff: { kind: 'fixed', initialMs: 0, maximumMs: 0 },
					onExhausted: 'fail-run',
				},
			},
			{
				id: 'output.success',
				label: 'Success',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
			{
				id: 'output.failure',
				label: 'Failure',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.error' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.action',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'action.create', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'action.create', port: 'success' },
				target: { nodeId: 'output.success', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'action.create', port: 'failure' },
				target: { nodeId: 'output.failure', port: 'input' },
			},
		],
		schemas: {
			'schema.data': schema,
			'schema.error': {
				type: 'object',
				required: ['code'],
				properties: { code: { type: 'string' } },
			},
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'action.create': { x: 250, y: 0 },
			'output.success': { x: 500, y: -100 },
			'output.failure': { x: 500, y: 100 },
		},
	};
}

function context() {
	return {
		tenantId: 'tenant-a',
		actor,
		origin: { kind: 'manual' } as const,
		permissionSnapshot: permissions,
	};
}

function dependencies(result: { current: JsonValue | null }) {
	let enqueues = 0;
	const childRuns = new Map<string, string>();
	const enqueueKeys: string[] = [];
	const enqueueGrants: string[][] = [];
	const authorizationSubjects: string[] = [];
	const agents: AgentRevisionExecutionCapability = {
		listRevisions: () => [
			{
				agentId: 'agent-1',
				revision: 3,
				name: 'Agent',
				status: 'active',
				supportsStructuredOutput: true,
				allowedTools: ['catalog.items.read'],
			},
		],
		getRevision: () => ({
			agentId: 'agent-1',
			revision: 3,
			name: 'Agent',
			status: 'active',
			supportsStructuredOutput: true,
			allowedTools: ['catalog.items.read'],
		}),
		enqueueRevision: async (request, context) => {
			enqueueKeys.push(request.idempotencyKey);
			enqueueGrants.push([...request.toolGrants]);
			authorizationSubjects.push(context.authorizationSubject?.id ?? 'missing');
			const existing = childRuns.get(request.idempotencyKey);
			if (existing) return { runId: existing, created: false };
			enqueues += 1;
			const runId = `child-run-${enqueues}`;
			childRuns.set(request.idempotencyKey, runId);
			return { runId, created: true };
		},
		readEvents: () => [],
		getResult: (runId) =>
			result.current === null
				? null
				: {
						runId,
						status: 'succeeded',
						output: null,
						structuredOutput: result.current,
						usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
						failureCode: null,
						completedAt: Date.now(),
					},
		requestCancel: () => true,
	};
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: () => [],
		start: async () => ({ actionInvocationId: 'action-1', created: true }),
		getResult: () => null,
		requestCancel: (actionInvocationId) => ({
			actionInvocationId,
			state: 'acknowledged',
		}),
	};
	return {
		agents,
		actions,
		enqueues: () => enqueues,
		enqueueKeys,
		enqueueGrants,
		authorizationSubjects,
	};
}

function actionDependencies(result: { current: ActionExecutionResult | null }) {
	let starts = 0;
	const actionInvocations = new Map<string, string>();
	const startKeys: string[] = [];
	const agent = dependencies({ current: null }).agents;
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: () => [
			{
				id: 'catalog.items.create',
				contractVersion: 1,
				description: 'Create catalog item',
				requiredPermissions: ['catalog.items.manage'],
				inputSchema: schema,
				outputSchema: schema,
				timeoutMs: 1_000,
				idempotency: 'required',
				risk: 'workspace-write',
				cancellation: 'cooperative',
			},
		],
		start: async (request) => {
			starts += 1;
			startKeys.push(request.idempotencyKey);
			const existing = actionInvocations.get(request.idempotencyKey);
			if (existing) return { actionInvocationId: existing, created: false };
			const actionInvocationId = `action-${actionInvocations.size + 1}`;
			actionInvocations.set(request.idempotencyKey, actionInvocationId);
			return { actionInvocationId, created: true };
		},
		getResult: (actionInvocationId) =>
			result.current ? { ...result.current, actionInvocationId } : null,
		requestCancel: (actionInvocationId) => ({
			actionInvocationId,
			state: 'acknowledged',
		}),
	};
	return {
		agents: agent,
		actions,
		starts: () => starts,
		created: () => actionInvocations.size,
		startKeys,
	};
}

function temporaryDatabase(): {
	readonly directory: string;
	readonly path: string;
} {
	const directory = mkdtempSync(join(tmpdir(), 'coreloom-workflows-backend-'));
	return { directory, path: join(directory, 'workflows.db') };
}

async function waitFor(
	predicate: () => boolean,
	timeout = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for workflow state.');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('workflow backend contracts', () => {
	it('redacts schema-marked secrets and permission-filtered fields before evidence persistence', () => {
		const value = {
			name: 'Ada',
			apiKey: 'by-name',
			privateNote: 'hidden',
			scoped: 'denied',
		};
		const evidence = safePayloadEvidence(value, 'schema.secure', {
			schema: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					privateNote: { type: 'string', 'x-coreloom-secret': true },
					scoped: {
						type: 'string',
						'x-coreloom-read-permission': 'private.read',
					},
				},
			},
			permissionSnapshot: [],
		});
		expect(evidence).toMatchObject({
			state: 'redacted',
			preview: {
				name: 'Ada',
				apiKey: '[redacted]',
				privateNote: '[redacted]',
				scoped: '[redacted]',
			},
		});
		expect(JSON.stringify(evidence)).not.toContain('hidden');
		expect(JSON.stringify(evidence)).not.toContain('denied');
	});

	it('refuses production startup without both stable workflow secrets', () => {
		expect(() =>
			assertProductionWorkflowSecrets(
				{ NODE_ENV: 'production' },
				{ payloadKey: false, cursorKey: false },
			),
		).toThrow(/CL_WORKFLOWS_PAYLOAD_KEY/);
		expect(() =>
			assertProductionWorkflowSecrets(
				{
					NODE_ENV: 'production',
					CL_WORKFLOWS_PAYLOAD_KEY: Buffer.alloc(32).toString('base64'),
					CL_WORKFLOWS_CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
				},
				{ payloadKey: false, cursorKey: false },
			),
		).not.toThrow();
	});

	it('keeps dry-run stateless and reports graph errors without creating history', () => {
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			payloadKey: Buffer.alloc(32, 9),
			cursorKey: Buffer.alloc(32, 8),
		});
		const service = runtime.service();
		const invalid = { ...directGraph(), edges: [] };
		const before = service.listRuns('tenant-a', {});
		const report = service.validate(invalid, context());
		expect(report.valid).toBe(false);
		expect(report.issues.map((issue) => issue.code)).toContain(
			'WORKFLOW_INPUT_UNCONNECTED',
		);
		expect(service.listRuns('tenant-a', {})).toEqual(before);
		runtime.dispose();
	});

	it('accepts tenant-local slug keys and rejects dotted or malformed keys', () => {
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			payloadKey: Buffer.alloc(32, 33),
			cursorKey: Buffer.alloc(32, 34),
		});
		const service = runtime.service();
		expect(
			service.create(
				'tenant-a',
				{
					key: 'catalog-enrichment',
					name: 'Catalog enrichment',
					description: '',
				},
				actor,
			).definition.key,
		).toBe('catalog-enrichment');
		for (const key of ['catalog.enrichment', 'A-flow', 'x', 'white space']) {
			expect(() =>
				service.create(
					'tenant-a',
					{ key, name: 'Invalid key', description: '' },
					actor,
				),
			).toThrow(/lowercase slug|between 3 and 120/);
		}
		runtime.dispose();
	});

	it('expires encrypted payloads only after terminal settlement and keeps typed evidence', () => {
		const repository = new SqliteWorkflowsRepository(
			':memory:',
			createWorkflowPayloadCodec(Buffer.alloc(32, 31)),
			0,
		);
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 32)),
		});
		const definition = service.create(
			'tenant-a',
			{ key: 'retention-flow', name: 'Retention', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Retention',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		const detail = service.simulate(
			{
				workflowId: definition.definition.id,
				input: { name: 'Secret input' },
				fixtures: [],
			},
			context(),
		);
		const run = repository.getRun('tenant-a', detail.run.id)!;
		expect(
			repository.readExecutionPayload('tenant-a', run.id, run.inputPayloadId),
		).toEqual({ name: 'Secret input' });
		expect(repository.applyPayloadRetention(Date.now() + 1)).toBeGreaterThan(0);
		expect(() =>
			repository.readExecutionPayload('tenant-a', run.id, run.inputPayloadId),
		).toThrow(/WORKFLOW_PAYLOAD_UNREADABLE/);
		const retained = service.getRunDetail('tenant-a', run.id);
		expect(retained.input).toMatchObject({
			state: 'expired',
			reason: 'retention',
		});
		expect(retained.input).not.toHaveProperty('preview');
		expect(retained.output).toMatchObject({
			state: 'expired',
			reason: 'retention',
		});
		expect(retained.events.at(-1)?.type).toBe('payload.retention.applied');
		repository.close();
	});

	it('binds opaque run cursors to the tenant and filter set', () => {
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			payloadKey: Buffer.alloc(32, 6),
			cursorKey: Buffer.alloc(32, 5),
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'page-flow', name: 'Page', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Page',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		for (const name of ['Ada', 'Grace'])
			service.simulate(
				{ workflowId: definition.definition.id, input: { name }, fixtures: [] },
				context(),
			);
		const first = service.listRuns('tenant-a', { limit: 1 });
		expect(first.runs).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		expect(
			service.listRuns('tenant-a', { limit: 1, cursor: first.nextCursor }).runs,
		).toHaveLength(1);
		expect(() =>
			service.listRuns('tenant-b', { limit: 1, cursor: first.nextCursor }),
		).toThrow(/another tenant or filter/);
		expect(() =>
			service.listRuns('tenant-a', { limit: 2, cursor: first.nextCursor }),
		).toThrow(/another tenant or filter/);
		runtime.dispose();
	});

	it('requires referenced action permissions and pins the published revision', () => {
		const registry = createPlatformCapabilityRegistry();
		const fake = dependencies({ current: null });
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, {
			...fake.actions,
			listWorkflowActions: () => [
				{
					id: 'catalog.items.create',
					contractVersion: 1,
					description: 'Create catalog item',
					requiredPermissions: ['catalog.items.manage'],
					inputSchema: schema,
					outputSchema: schema,
					timeoutMs: 1_000,
					idempotency: 'required',
					risk: 'workspace-write',
					cancellation: 'cooperative',
				},
			],
		});
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 41),
			cursorKey: Buffer.alloc(32, 42),
		});
		const service = runtime.service();
		const created = service.create(
			'tenant-a',
			{ key: 'action-flow', name: 'Action', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Action',
				description: '',
				graph: actionGraph(),
			},
			actor,
		);
		expect(() =>
			service.publish('tenant-a', created.definition.id, 2, actor, permissions),
		).toThrow(/permission is required/);
		const published = service.publish(
			'tenant-a',
			created.definition.id,
			2,
			actor,
			[...permissions, 'catalog.items.manage'],
		);
		expect(published.definition.publishedRevision).toBe(2);
		const changed = service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 2,
				name: 'Action v2',
				description: '',
				graph: actionGraph(),
			},
			actor,
		);
		expect(changed.definition).toMatchObject({
			currentDraftRevision: 3,
			publishedRevision: 2,
		});
		expect(
			changed.revisions.find((revision) => revision.revision === 2),
		).toMatchObject({ publishedAt: expect.any(Number) });
		runtime.dispose();
	});

	it('refuses a tool grant outside the pinned agent revision', () => {
		const fake = dependencies({ current: null });
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 66),
			cursorKey: Buffer.alloc(32, 67),
		});
		const service = runtime.service();
		const graph = agentGraph();
		const node = graph.nodes.find((entry) => entry.type === 'agent')!;
		const invalid = {
			...graph,
			nodes: graph.nodes.map((entry) =>
				entry.id === node.id
					? { ...node, toolGrants: ['catalog.items.delete'] }
					: entry,
			),
		} as WorkflowGraphV1;
		expect(service.validate(invalid, context()).issues).toMatchObject([
			{ code: 'WORKFLOW_AGENT_TOOL_GRANT_NOT_ALLOWED' },
		]);
		runtime.dispose();
	});

	it('does not append audit evidence when optimistic draft save is refused', () => {
		const repository = new SqliteWorkflowsRepository(':memory:');
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 43)),
		});
		const created = service.create(
			'tenant-a',
			{ key: 'conflict-flow', name: 'Conflict', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Updated',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		const auditBefore = repository.listAudit('tenant-a', 100).events;
		expect(() =>
			service.update(
				'tenant-a',
				{
					workflowId: created.definition.id,
					expectedRevision: 1,
					name: 'Stale',
					description: '',
					graph: directGraph(),
				},
				actor,
			),
		).toThrow(/changed before this save/);
		expect(repository.listAudit('tenant-a', 100).events).toEqual(auditBefore);
		repository.close();
	});

	it('rolls back a run projection and ordered events when audit persistence fails', () => {
		const temporary = temporaryDatabase();
		const repository = new SqliteWorkflowsRepository(
			temporary.path,
			createWorkflowPayloadCodec(Buffer.alloc(32, 44)),
		);
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 45)),
		});
		const created = service.create(
			'tenant-a',
			{ key: 'atomic-flow', name: 'Atomic', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Atomic',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		const database = new DatabaseSync(temporary.path);
		try {
			database.exec(`CREATE TRIGGER reject_workflow_run_audit
				BEFORE INSERT ON workflow_audit_events
				WHEN NEW.action = 'workflow-run.enqueued'
				BEGIN SELECT RAISE(ABORT, 'audit persistence failed'); END`);
			expect(() =>
				service.simulate(
					{
						workflowId: created.definition.id,
						input: { name: 'Ada' },
						fixtures: [],
					},
					context(),
				),
			).toThrow(/audit persistence failed/);
			expect(
				database.prepare('SELECT count(*) AS count FROM workflow_runs').get(),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare('SELECT count(*) AS count FROM workflow_run_events')
					.get(),
			).toEqual({ count: 0 });
		} finally {
			database.close();
			repository.close();
			rmSync(temporary.directory, { recursive: true, force: true });
		}
	});

	it('executes a durable direct workflow and exposes ordered terminal evidence', async () => {
		const registry = createPlatformCapabilityRegistry();
		const fake = dependencies({ current: null });
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 1),
			cursorKey: Buffer.alloc(32, 2),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'direct-flow', name: 'Direct', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Direct',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'direct-flow',
				input: { name: 'Ada' },
				idempotencyKey: 'direct-flow:1',
			},
			context(),
		);
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'succeeded',
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.output).toMatchObject({
			state: 'available',
			preview: { name: 'Ada' },
		});
		expect(detail.events.at(-1)?.type).toBe('run.succeeded');
		expect(service.verifyAudit('tenant-a')).toMatchObject({ valid: true });
		runtime.dispose();
	});

	it('persists a child correlation before waiting and resumes it without a duplicate enqueue', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 3),
			cursorKey: Buffer.alloc(32, 4),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'agent-flow', name: 'Agent flow', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Agent flow',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		expect(service.validate(agentGraph(), context()).issues).toEqual([]);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'agent-flow',
				input: { name: 'Ada' },
				idempotencyKey: 'agent-flow:1',
			},
			context(),
		);
		await waitFor(
			() =>
				service.getRun('tenant-a', accepted.runId)?.status === 'waiting-agent',
		);
		expect(fake.enqueues()).toBe(1);
		expect(fake.enqueueGrants).toEqual([['catalog.items.read']]);
		expect(fake.authorizationSubjects).toEqual(['owner-1']);
		expect(
			service
				.getRunDetail('tenant-a', accepted.runId)
				.nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0],
		).toMatchObject({ childId: 'child-run-1', status: 'waiting-child' });
		result.current = { name: 'Ada enriched' };
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'succeeded',
		);
		expect(fake.enqueues()).toBe(1);
		expect(service.getRun('tenant-a', accepted.runId)?.usage).toMatchObject({
			totalTokens: 7,
			unpricedChildRuns: 1,
			state: 'final',
		});
		result.current = {
			name: 'x'.repeat(WORKFLOW_LIMITS.maxEnvelopeBytes + 1),
		};
		const oversized = await service.enqueue(
			{
				workflowKey: 'agent-flow',
				input: { name: 'Oversized' },
				idempotencyKey: 'agent-flow:oversized',
			},
			context(),
		);
		await waitFor(
			() => service.getRun('tenant-a', oversized.runId)?.status === 'refused',
		);
		expect(service.getRun('tenant-a', oversized.runId)?.failureCode).toBe(
			'WORKFLOW_OUTPUT_LIMIT_EXCEEDED',
		);
		runtime.dispose();
	});

	it('preserves a permanent agent refusal instead of classifying it as retryable failure', async () => {
		const base = dependencies({ current: null });
		const refusingAgents: AgentRevisionExecutionCapability = {
			...base.agents,
			enqueueRevision: async () => {
				throw Object.assign(new Error('Agent execution was refused.'), {
					code: 'AGENT_PERMISSION_DENIED',
				});
			},
		};
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, refusingAgents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, base.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 60),
			cursorKey: Buffer.alloc(32, 61),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'agent-refusal', name: 'Agent refusal', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Agent refusal',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'agent-refusal',
				input: { name: 'Ada' },
				idempotencyKey: 'agent-refusal:1',
			},
			context(),
		);
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'refused',
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.run.failureCode).toBe('AGENT_PERMISSION_DENIED');
		expect(
			detail.nodes.find((node) => node.nodeId === 'agent.process')?.attempts,
		).toMatchObject([
			{
				status: 'refused',
				retryClassification: 'permanent',
				failureCode: 'AGENT_PERMISSION_DENIED',
			},
		]);
		expect(base.enqueues()).toBe(0);
		runtime.dispose();
	});

	it('executes and refuses action nodes through the versioned public capability', async () => {
		const actionResult: { current: ActionExecutionResult | null } = {
			current: null,
		};
		const fake = actionDependencies(actionResult);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 46),
			cursorKey: Buffer.alloc(32, 47),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'action-execution', name: 'Action execution', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Action execution',
				description: '',
				graph: actionGraph(),
			},
			actor,
		);
		const executionPermissions = [...permissions, 'catalog.items.manage'];
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			executionPermissions,
		);
		expect(
			service.executionCapability().getPublishedReference('action-execution', {
				...context(),
				permissionSnapshot: executionPermissions,
			}),
		).toMatchObject({
			id: definition.definition.id,
			key: 'action-execution',
			revision: 2,
			requiredPermissions: ['catalog.items.manage'],
		});
		runtime.start();

		const succeeded = await service.enqueue(
			{
				workflowKey: 'action-execution',
				input: { name: 'Ada' },
				idempotencyKey: 'action-execution:success',
			},
			{ ...context(), permissionSnapshot: executionPermissions },
		);
		await waitFor(
			() =>
				service
					.getRunDetail('tenant-a', succeeded.runId)
					.nodes.find((node) => node.nodeId === 'action.create')?.attempts[0]
					?.status === 'waiting-child',
		);
		actionResult.current = {
			actionInvocationId: 'replaced-by-fake',
			status: 'succeeded',
			output: { name: 'Created' },
		};
		await waitFor(
			() => service.getRun('tenant-a', succeeded.runId)?.status === 'succeeded',
		);
		expect(service.getRun('tenant-a', succeeded.runId)).toMatchObject({
			usage: { actionInvocations: 1, unpricedActions: 1, state: 'final' },
			cost: { unpricedActions: 1, state: 'final' },
		});

		actionResult.current = null;
		const refused = await service.enqueue(
			{
				workflowKey: 'action-execution',
				input: { name: 'Grace' },
				idempotencyKey: 'action-execution:refused',
			},
			{ ...context(), permissionSnapshot: executionPermissions },
		);
		await waitFor(
			() =>
				service
					.getRunDetail('tenant-a', refused.runId)
					.nodes.find((node) => node.nodeId === 'action.create')?.attempts[0]
					?.status === 'waiting-child',
		);
		actionResult.current = {
			actionInvocationId: 'replaced-by-fake',
			status: 'refused',
			output: { code: 'ACTION_PERMISSION_DENIED' },
			code: 'ACTION_PERMISSION_DENIED',
		};
		await waitFor(
			() => service.getRun('tenant-a', refused.runId)?.status === 'refused',
		);
		expect(service.getRun('tenant-a', refused.runId)).toMatchObject({
			failureCode: 'ACTION_PERMISSION_DENIED',
			usage: { actionInvocations: 1 },
		});
		expect(fake.starts()).toBe(2);
		runtime.dispose();
	});

	it('persists retry evidence, exhausts the policy, and counts child usage once', async () => {
		const base = dependencies({ current: null });
		const failingAgents: AgentRevisionExecutionCapability = {
			...base.agents,
			getResult: (runId) => ({
				runId,
				status: 'failed',
				output: null,
				structuredOutput: null,
				usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
				failureCode: 'PROVIDER_FAILED',
				completedAt: Date.now(),
			}),
		};
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, failingAgents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, base.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 48),
			cursorKey: Buffer.alloc(32, 49),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'retry-exhaustion', name: 'Retry exhaustion', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Retry exhaustion',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'retry-exhaustion',
				input: { name: 'Ada' },
				idempotencyKey: 'retry-exhaustion:1',
			},
			context(),
		);
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'failed',
			4_000,
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		const attempts = detail.nodes.find(
			(node) => node.nodeId === 'agent.process',
		)?.attempts;
		expect(attempts).toHaveLength(2);
		expect(attempts?.map((attempt) => attempt.failureCode)).toEqual([
			'PROVIDER_FAILED',
			'PROVIDER_FAILED',
		]);
		expect(
			new Set(attempts?.map((attempt) => attempt.semanticGroup)).size,
		).toBe(1);
		expect(detail.events.map((event) => event.type)).toEqual(
			expect.arrayContaining(['node.retry.scheduled', 'node.retry.started']),
		);
		expect(detail.run.usage).toMatchObject({
			totalTokens: 6,
			includedChildRunIds: ['child-run-1', 'child-run-2'],
			unpricedChildRuns: 2,
			state: 'final',
		});
		expect(base.enqueues()).toBe(2);
		expect(base.enqueueKeys).toEqual([
			`tenant-a:${accepted.runId}:agent.process:attempt:1`,
			`tenant-a:${accepted.runId}:agent.process:attempt:2`,
		]);
		runtime.dispose();
	});

	it('retries workspace-write actions with one stable side-effect key and invocation', async () => {
		const actionResult: { current: ActionExecutionResult | null } = {
			current: {
				actionInvocationId: 'replaced-by-fake',
				status: 'failed',
				output: { code: 'ACTION_TRANSIENT' },
				code: 'ACTION_TRANSIENT',
			},
		};
		const fake = actionDependencies(actionResult);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 56),
			cursorKey: Buffer.alloc(32, 57),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'action-retry', name: 'Action retry', description: '' },
			actor,
		);
		const graph = actionGraph(2, ['ACTION_TRANSIENT']);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Action retry',
				description: '',
				graph,
			},
			actor,
		);
		const executionPermissions = [...permissions, 'catalog.items.manage'];
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			executionPermissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'action-retry',
				input: { name: 'Ada' },
				idempotencyKey: 'action-retry:1',
			},
			{ ...context(), permissionSnapshot: executionPermissions },
		);
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'failed',
			4_000,
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		const attempts = detail.nodes.find(
			(node) => node.nodeId === 'action.create',
		)?.attempts;
		expect(attempts).toHaveLength(2);
		expect(attempts?.map((attempt) => attempt.childId)).toEqual([
			'action-1',
			'action-1',
		]);
		expect(fake.starts()).toBe(2);
		expect(fake.created()).toBe(1);
		expect(new Set(fake.startKeys)).toEqual(
			new Set([`tenant-a:${accepted.runId}:action.create`]),
		);
		expect(detail.run.usage).toMatchObject({
			actionInvocations: 1,
			unpricedActions: 1,
		});
		runtime.dispose();
	});

	it('recovers an expired child wait after restart without enqueueing the child again', async () => {
		const temporary = temporaryDatabase();
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const payloadKey = Buffer.alloc(32, 50);
		const cursorKey = Buffer.alloc(32, 51);
		const first = createWorkflowsRuntime({
			databasePath: temporary.path,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		let runId = '';
		try {
			const service = first.service();
			const definition = service.create(
				'tenant-a',
				{ key: 'restart-recovery', name: 'Restart recovery', description: '' },
				actor,
			);
			service.update(
				'tenant-a',
				{
					workflowId: definition.definition.id,
					expectedRevision: 1,
					name: 'Restart recovery',
					description: '',
					graph: agentGraph(),
				},
				actor,
			);
			service.publish(
				'tenant-a',
				definition.definition.id,
				2,
				actor,
				permissions,
			);
			first.start();
			runId = (
				await service.enqueue(
					{
						workflowKey: 'restart-recovery',
						input: { name: 'Ada' },
						idempotencyKey: 'restart-recovery:1',
					},
					context(),
				)
			).runId;
			await waitFor(
				() => service.getRun('tenant-a', runId)?.status === 'waiting-agent',
			);
			expect(fake.enqueues()).toBe(1);
		} finally {
			first.dispose();
		}

		const database = new DatabaseSync(temporary.path);
		database
			.prepare(
				`UPDATE workflow_runs SET lease_owner = 'crashed-worker', lease_expires_at = 1
				 WHERE tenant_id = 'tenant-a' AND id = ?`,
			)
			.run(runId);
		database.close();
		result.current = { name: 'Recovered' };
		const second = createWorkflowsRuntime({
			databasePath: temporary.path,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		try {
			second.start();
			await waitFor(
				() =>
					second.service().getRun('tenant-a', runId)?.status === 'succeeded',
				4_000,
			);
			const detail = second.service().getRunDetail('tenant-a', runId);
			expect(detail.events.map((event) => event.type)).toContain(
				'run.recovered',
			);
			expect(fake.enqueues()).toBe(1);
		} finally {
			second.dispose();
			rmSync(temporary.directory, { recursive: true, force: true });
		}
	});

	it('persists a child observation deadline and refuses a stuck child after restart', async () => {
		const temporary = temporaryDatabase();
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const payloadKey = Buffer.alloc(32, 62);
		const cursorKey = Buffer.alloc(32, 63);
		let workerNow = Date.now();
		const first = createWorkflowsRuntime({
			databasePath: temporary.path,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: {
				pollMs: 250,
				leaseMs: 1_000,
				now: () => workerNow,
			},
		});
		let runId = '';
		let deadline = 0;
		try {
			const service = first.service();
			const definition = service.create(
				'tenant-a',
				{ key: 'child-deadline', name: 'Child deadline', description: '' },
				actor,
			);
			service.update(
				'tenant-a',
				{
					workflowId: definition.definition.id,
					expectedRevision: 1,
					name: 'Child deadline',
					description: '',
					graph: agentGraph(),
				},
				actor,
			);
			service.publish(
				'tenant-a',
				definition.definition.id,
				2,
				actor,
				permissions,
			);
			first.start();
			runId = (
				await service.enqueue(
					{
						workflowKey: 'child-deadline',
						input: { name: 'Ada' },
						idempotencyKey: 'child-deadline:1',
					},
					context(),
				)
			).runId;
			await waitFor(
				() => service.getRun('tenant-a', runId)?.status === 'waiting-agent',
			);
			const attempt = service
				.getRunDetail('tenant-a', runId)
				.nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0];
			deadline = attempt?.childObservationDeadlineAt ?? 0;
			expect(deadline).toBe(workerNow + WORKFLOW_LIMITS.maxChildObservationMs);
			expect(deadline).toBeLessThanOrEqual(
				service.getRun('tenant-a', runId)!.queuedAt +
					WORKFLOW_LIMITS.maxLiveDurationMs,
			);
		} finally {
			await Promise.resolve(first.dispose());
		}

		workerNow = deadline;
		const second = createWorkflowsRuntime({
			databasePath: temporary.path,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: {
				pollMs: 250,
				leaseMs: 1_000,
				now: () => workerNow,
			},
		});
		try {
			second.start();
			await waitFor(
				() => second.service().getRun('tenant-a', runId)?.status === 'refused',
			);
			const detail = second.service().getRunDetail('tenant-a', runId);
			expect(detail.run.failureCode).toBe('WORKFLOW_CHILD_OBSERVATION_TIMEOUT');
			expect(
				detail.nodes.find((node) => node.nodeId === 'agent.process')
					?.attempts[0],
			).toMatchObject({
				status: 'refused',
				childObservationDeadlineAt: deadline,
				failureCode: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
			});
			expect(fake.enqueues()).toBe(1);
		} finally {
			await Promise.resolve(second.dispose());
			rmSync(temporary.directory, { recursive: true, force: true });
		}
	});

	it('allows one worker to recover a lost lease without duplicate child settlement', async () => {
		const temporary = temporaryDatabase();
		const registry = createPlatformCapabilityRegistry();
		const base = dependencies({ current: null });
		let enqueueCalls = 0;
		let createdChildren = 0;
		let releaseFirst!: () => void;
		let signalFirstStarted!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			signalFirstStarted = resolve;
		});
		const children = new Map<string, string>();
		const result: { current: JsonValue | null } = { current: null };
		const contendedAgents: AgentRevisionExecutionCapability = {
			...base.agents,
			enqueueRevision: async (request) => {
				enqueueCalls += 1;
				let childId = children.get(request.idempotencyKey);
				const created = childId === undefined;
				if (!childId) {
					childId = `contended-child-${children.size + 1}`;
					children.set(request.idempotencyKey, childId);
					createdChildren += 1;
				}
				if (enqueueCalls === 1) {
					signalFirstStarted();
					await firstBlocked;
				}
				return { runId: childId, created };
			},
			getResult: (runId) =>
				result.current === null
					? null
					: {
							runId,
							status: 'succeeded',
							output: null,
							structuredOutput: result.current,
							usage: null,
							failureCode: null,
							completedAt: Date.now(),
						},
		};
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, contendedAgents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, base.actions);
		const shared = {
			databasePath: temporary.path,
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 64),
			cursorKey: Buffer.alloc(32, 65),
		};
		const first = createWorkflowsRuntime({
			...shared,
			worker: { workerId: 'workflow-worker-one', pollMs: 250, leaseMs: 1_000 },
		});
		const second = createWorkflowsRuntime({
			...shared,
			worker: { workerId: 'workflow-worker-two', pollMs: 250, leaseMs: 1_000 },
		});
		let runId = '';
		try {
			const service = first.service();
			const definition = service.create(
				'tenant-a',
				{ key: 'lease-contention', name: 'Lease contention', description: '' },
				actor,
			);
			service.update(
				'tenant-a',
				{
					workflowId: definition.definition.id,
					expectedRevision: 1,
					name: 'Lease contention',
					description: '',
					graph: agentGraph(),
				},
				actor,
			);
			service.publish(
				'tenant-a',
				definition.definition.id,
				2,
				actor,
				permissions,
			);
			first.start();
			runId = (
				await service.enqueue(
					{
						workflowKey: 'lease-contention',
						input: { name: 'Ada' },
						idempotencyKey: 'lease-contention:1',
					},
					context(),
				)
			).runId;
			await firstStarted;
			second.start();
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect(enqueueCalls).toBe(1);

			const database = new DatabaseSync(temporary.path);
			database
				.prepare(
					`UPDATE workflow_runs SET lease_owner = 'lost-owner', lease_expires_at = 1
					 WHERE tenant_id = 'tenant-a' AND id = ?`,
				)
				.run(runId);
			database.close();
			await waitFor(() => enqueueCalls === 2);
			await waitFor(
				() =>
					second
						.service()
						.getRunDetail('tenant-a', runId)
						.nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0]
						?.status === 'waiting-child',
			);
			await new Promise((resolve) => setTimeout(resolve, 600));
			result.current = { name: 'Recovered exactly once' };
			releaseFirst();
			await waitFor(
				() =>
					second.service().getRun('tenant-a', runId)?.status === 'succeeded',
				4_000,
			);
			const detail = second.service().getRunDetail('tenant-a', runId);
			expect(enqueueCalls).toBe(2);
			expect(createdChildren).toBe(1);
			expect(
				detail.events.filter((event) => event.type === 'run.recovered'),
			).toHaveLength(1);
			expect(
				detail.events.filter((event) => event.type === 'node.child.waiting'),
			).toHaveLength(1);
			expect(
				detail.events.filter((event) => event.type === 'node.attempt.settled'),
			).toHaveLength(3);
			expect(
				detail.events.filter((event) => event.type === 'run.succeeded'),
			).toHaveLength(1);
		} finally {
			releaseFirst();
			await Promise.resolve(first.dispose());
			await Promise.resolve(second.dispose());
			rmSync(temporary.directory, { recursive: true, force: true });
		}
	});

	it('deduplicates child usage and unpriced cost by child run id', async () => {
		const fake = dependencies({ current: null });
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const repository = new SqliteWorkflowsRepository(
			':memory:',
			createWorkflowPayloadCodec(Buffer.alloc(32, 52)),
		);
		const service = new WorkflowsService(repository, {
			capabilities: registry,
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 53)),
		});
		const definition = service.create(
			'tenant-a',
			{
				key: 'cost-deduplication',
				name: 'Cost deduplication',
				description: '',
			},
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Cost deduplication',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		const runId = (
			await service.enqueue(
				{
					workflowKey: 'cost-deduplication',
					input: { name: 'Ada' },
					idempotencyKey: 'cost-deduplication:1',
				},
				context(),
			)
		).runId;
		for (let index = 0; index < 2; index += 1) {
			repository.recordAgentUsage('tenant-a', runId, 'child-run-stable', {
				inputTokens: 4,
				outputTokens: 3,
				totalTokens: 7,
			});
		}
		expect(repository.getRun('tenant-a', runId)).toMatchObject({
			usage: {
				inputTokens: 4,
				outputTokens: 3,
				totalTokens: 7,
				includedChildRunIds: ['child-run-stable'],
				unpricedChildRuns: 1,
			},
			cost: { unpricedChildRuns: 1 },
		});
		repository.close();
	});

	it('makes cancellation idempotent and lets the worker settle a queued run', async () => {
		const registry = createPlatformCapabilityRegistry();
		const fake = dependencies({ current: null });
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 11),
			cursorKey: Buffer.alloc(32, 12),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'cancel-flow', name: 'Cancel', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Cancel',
				description: '',
				graph: directGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		const accepted = await service.enqueue(
			{
				workflowKey: 'cancel-flow',
				input: { name: 'Ada' },
				idempotencyKey: 'cancel-flow:1',
			},
			context(),
		);
		expect(service.cancel('tenant-a', accepted.runId, actor)).toMatchObject({
			requested: true,
			status: 'cancel-requested',
		});
		expect(service.cancel('tenant-a', accepted.runId, actor)).toMatchObject({
			requested: false,
			status: 'cancel-requested',
		});
		runtime.start();
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'cancelled',
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.events.map((event) => event.type)).toContain('run.cancelled');
		expect(() =>
			service.readEvents('tenant-a', accepted.runId, 10_000),
		).toThrow(/ahead/);
		expect(service.getRun('tenant-b', accepted.runId)).toBeNull();
		runtime.dispose();
	});

	it('observes an accepted child to terminal and discards its late result after cancellation', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 58),
			cursorKey: Buffer.alloc(32, 59),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'cancel-child', name: 'Cancel child', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Cancel child',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'cancel-child',
				input: { name: 'Ada' },
				idempotencyKey: 'cancel-child:1',
			},
			context(),
		);
		await waitFor(
			() =>
				service.getRun('tenant-a', accepted.runId)?.status === 'waiting-agent',
		);
		service.cancel('tenant-a', accepted.runId, actor);
		await waitFor(() =>
			service
				.getRunDetail('tenant-a', accepted.runId)
				.events.some((event) => event.type === 'node.cancel.acknowledged'),
		);
		await new Promise((resolve) => setTimeout(resolve, 600));
		let detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.run.status).toBe('cancel-requested');
		expect(
			detail.events.filter((event) => event.type === 'node.cancel.requested'),
		).toHaveLength(1);
		result.current = { name: 'must not be routed' };
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'cancelled',
		);
		detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(
			detail.nodes.find((node) => node.nodeId === 'agent.process')?.status,
		).toBe('cancelled');
		expect(detail.edges.map((edge) => edge.edgeId)).not.toContain(
			'edge.success',
		);
		expect(detail.events.map((event) => event.type)).toContain(
			'node.result.late-ignored',
		);
		expect(JSON.stringify(detail)).not.toContain('must not be routed');
		expect(
			detail.nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0]
				?.output,
		).toMatchObject({ state: 'redacted', reason: 'secret' });
		expect(detail.run.usage).toMatchObject({ totalTokens: 7 });
		runtime.dispose();
	});

	it('settles cancellation with durable evidence when child observation expires', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		let workerNow = Date.now();
		const runtime = createWorkflowsRuntime({
			databasePath: ':memory:',
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 66),
			cursorKey: Buffer.alloc(32, 67),
			worker: {
				pollMs: 250,
				leaseMs: 1_000,
				now: () => workerNow,
			},
		});
		const service = runtime.service();
		const definition = service.create(
			'tenant-a',
			{ key: 'cancel-deadline', name: 'Cancel deadline', description: '' },
			actor,
		);
		service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Cancel deadline',
				description: '',
				graph: agentGraph(),
			},
			actor,
		);
		service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		runtime.start();
		const accepted = await service.enqueue(
			{
				workflowKey: 'cancel-deadline',
				input: { name: 'Ada' },
				idempotencyKey: 'cancel-deadline:1',
			},
			context(),
		);
		await waitFor(
			() =>
				service.getRun('tenant-a', accepted.runId)?.status === 'waiting-agent',
		);
		const deadline = service
			.getRunDetail('tenant-a', accepted.runId)
			.nodes.find((node) => node.nodeId === 'agent.process')
			?.attempts[0]?.childObservationDeadlineAt;
		expect(deadline).toEqual(expect.any(Number));
		service.cancel('tenant-a', accepted.runId, actor);
		await waitFor(() =>
			service
				.getRunDetail('tenant-a', accepted.runId)
				.events.some((event) => event.type === 'node.cancel.acknowledged'),
		);
		workerNow = deadline!;
		await waitFor(
			() => service.getRun('tenant-a', accepted.runId)?.status === 'cancelled',
		);
		const detail = service.getRunDetail('tenant-a', accepted.runId);
		expect(
			detail.events.find(
				(event) =>
					event.type === 'node.cancel.not-acknowledged' &&
					event.payload.reason === 'child-observation-timeout',
			),
		).toBeDefined();
		expect(
			detail.nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0],
		).toMatchObject({
			status: 'cancelled',
			failureCode: 'WORKFLOW_CHILD_OBSERVATION_TIMEOUT',
		});
		await Promise.resolve(runtime.dispose());
	});
});
