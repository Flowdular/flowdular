import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type ActionExecutionResult,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
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
import type { CreateWorkflowRunWrite } from '../src/services/repository.ts';
import {
	createWorkflowsTestProvider,
	createWorkflowsTestRuntime,
	executeAsOwner,
	executeScriptAsOwner,
	openWorkflowsTestRepository,
	withHandle,
	withOwnerHandle,
} from './support/database.ts';

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
		listRevisions: async () => [
			{
				agentId: 'agent-1',
				revision: 3,
				name: 'Agent',
				status: 'active',
				supportsStructuredOutput: true,
				allowedTools: ['catalog.items.read'],
			},
		],
		getRevision: async () => ({
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
		readEvents: async () => [],
		getResult: async (runId) =>
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
		requestCancel: async () => true,
	};
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: async () => [],
		start: async () => ({ actionInvocationId: 'action-1', created: true }),
		getResult: async () => null,
		requestCancel: async (actionInvocationId) => ({
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
		listWorkflowActions: async () => [
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
		getResult: async (actionInvocationId) =>
			result.current ? { ...result.current, actionInvocationId } : null,
		requestCancel: async (actionInvocationId) => ({
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

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeout = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for workflow state.');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('workflow backend contracts', () => {
	it.each(['flowdular', 'coreloom'])(
		'redacts %s schema-marked secrets and permission-filtered fields before evidence persistence',
		async (brand) => {
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
						privateNote: { type: 'string', [`x-${brand}-secret`]: true },
						scoped: {
							type: 'string',
							[`x-${brand}-read-permission`]: 'private.read',
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
		},
	);

	it('refuses production startup without both stable workflow secrets', async () => {
		expect(() =>
			assertProductionWorkflowSecrets(
				{ NODE_ENV: 'production' },
				{ payloadKey: false, cursorKey: false },
			),
		).toThrow(/FD_WORKFLOWS_PAYLOAD_KEY/);
		expect(() =>
			assertProductionWorkflowSecrets(
				{
					NODE_ENV: 'production',
					FD_WORKFLOWS_PAYLOAD_KEY: Buffer.alloc(32).toString('base64'),
					FD_WORKFLOWS_CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
				},
				{ payloadKey: false, cursorKey: false },
			),
		).not.toThrow();
	});

	it('keeps dry-run stateless and reports graph errors without creating history', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 9),
			cursorKey: Buffer.alloc(32, 8),
		});
		const service = await runtime.service();
		const invalid = { ...directGraph(), edges: [] };
		const before = await service.listRuns('tenant-a', {});
		const report = await service.validate(invalid, context());
		expect(report.valid).toBe(false);
		expect(report.issues.map((issue) => issue.code)).toContain(
			'WORKFLOW_INPUT_UNCONNECTED',
		);
		expect(await service.listRuns('tenant-a', {})).toEqual(before);
		await runtime.dispose();
	});

	it('accepts tenant-local slug keys and rejects dotted or malformed keys', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 33),
			cursorKey: Buffer.alloc(32, 34),
		});
		const service = await runtime.service();
		expect(
			(
				await service.create(
					'tenant-a',
					{
						key: 'catalog-enrichment',
						name: 'Catalog enrichment',
						description: '',
					},
					actor,
				)
			).definition.key,
		).toBe('catalog-enrichment');
		for (const key of ['catalog.enrichment', 'A-flow', 'x', 'white space']) {
			await expect(
				service.create(
					'tenant-a',
					{ key, name: 'Invalid key', description: '' },
					actor,
				),
			).rejects.toThrow(/lowercase slug|between 3 and 120/);
		}
		await runtime.dispose();
	});

	it('expires encrypted payloads only after terminal settlement and keeps typed evidence', async () => {
		const database = await openWorkflowsTestRepository({
			payloadCodec: createWorkflowPayloadCodec(Buffer.alloc(32, 31)),
			payloadRetentionMs: 0,
		});
		const repository = database.repository;
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 32)),
		});
		const definition = await service.create(
			'tenant-a',
			{ key: 'retention-flow', name: 'Retention', description: '' },
			actor,
		);
		await service.update(
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
		const detail = await service.simulate(
			{
				workflowId: definition.definition.id,
				input: { name: 'Secret input' },
				fixtures: [],
			},
			context(),
		);
		const run = (await repository.getRun('tenant-a', detail.run.id))!;
		expect(
			await repository.readExecutionPayload(
				'tenant-a',
				run.id,
				run.inputPayloadId,
			),
		).toEqual({ name: 'Secret input' });
		expect(
			await repository.applyPayloadRetention(Date.now() + 1),
		).toBeGreaterThan(0);
		await expect(
			repository.readExecutionPayload('tenant-a', run.id, run.inputPayloadId),
		).rejects.toThrow(/WORKFLOW_PAYLOAD_UNREADABLE/);
		const retained = await service.getRunDetail('tenant-a', run.id);
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
		await database.dispose();
	});

	it('binds opaque run cursors to the tenant and filter set', async () => {
		const runtime = createWorkflowsTestRuntime({
			payloadKey: Buffer.alloc(32, 6),
			cursorKey: Buffer.alloc(32, 5),
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'page-flow', name: 'Page', description: '' },
			actor,
		);
		await service.update(
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
			await service.simulate(
				{ workflowId: definition.definition.id, input: { name }, fixtures: [] },
				context(),
			);
		const first = await service.listRuns('tenant-a', { limit: 1 });
		expect(first.runs).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		expect(
			(
				await service.listRuns('tenant-a', {
					limit: 1,
					cursor: first.nextCursor,
				})
			).runs,
		).toHaveLength(1);
		await expect(
			service.listRuns('tenant-b', {
				limit: 1,
				cursor: first.nextCursor,
			}),
		).rejects.toThrow(/another tenant or filter/);
		await expect(
			service.listRuns('tenant-a', {
				limit: 2,
				cursor: first.nextCursor,
			}),
		).rejects.toThrow(/another tenant or filter/);
		await runtime.dispose();
	});

	it('requires referenced action permissions and pins the published revision', async () => {
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
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 41),
			cursorKey: Buffer.alloc(32, 42),
		});
		const service = await runtime.service();
		const created = await service.create(
			'tenant-a',
			{ key: 'action-flow', name: 'Action', description: '' },
			actor,
		);
		await service.update(
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
		await expect(
			service.publish('tenant-a', created.definition.id, 2, actor, permissions),
		).rejects.toThrow(/permission is required/);
		const published = await service.publish(
			'tenant-a',
			created.definition.id,
			2,
			actor,
			[...permissions, 'catalog.items.manage'],
		);
		expect(published.definition.publishedRevision).toBe(2);
		const changed = await service.update(
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
		await runtime.dispose();
	});

	it('refuses a tool grant outside the pinned agent revision', async () => {
		const fake = dependencies({ current: null });
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 66),
			cursorKey: Buffer.alloc(32, 67),
		});
		const service = await runtime.service();
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
		expect((await service.validate(invalid, context())).issues).toMatchObject([
			{ code: 'WORKFLOW_AGENT_TOOL_GRANT_NOT_ALLOWED' },
		]);
		await runtime.dispose();
	});

	it('does not append audit evidence when optimistic draft save is refused', async () => {
		const database = await openWorkflowsTestRepository();
		const repository = database.repository;
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 43)),
		});
		const created = await service.create(
			'tenant-a',
			{ key: 'conflict-flow', name: 'Conflict', description: '' },
			actor,
		);
		await service.update(
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
		const auditBefore = (await repository.listAudit('tenant-a', 100)).events;
		await expect(
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
		).rejects.toThrow(/changed before this save/);
		expect((await repository.listAudit('tenant-a', 100)).events).toEqual(
			auditBefore,
		);
		await database.dispose();
	});

	it('rolls back a run projection and ordered events when audit persistence fails', async () => {
		const database = await openWorkflowsTestRepository({
			payloadCodec: createWorkflowPayloadCodec(Buffer.alloc(32, 44)),
		});
		const repository = database.repository;
		const service = new WorkflowsService(repository, {
			capabilities: createPlatformCapabilityRegistry(),
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 45)),
		});
		const created = await service.create(
			'tenant-a',
			{ key: 'atomic-flow', name: 'Atomic', description: '' },
			actor,
		);
		await service.update(
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
		const rowCount = async (table: string): Promise<number> => {
			const counted = await withOwnerHandle(database.databases, (owner) =>
				owner.transaction(
					(transaction) =>
						transaction.query<{ count: string }>({
							text: `SELECT count(*) AS count FROM ${table}`,
						}),
					{ access: 'read', tenantId: 'tenant-a' },
				),
			);
			return Number(counted.rows[0]?.count ?? 0);
		};
		try {
			await executeScriptAsOwner(
				database.databases,
				`CREATE FUNCTION reject_workflow_run_audit() RETURNS trigger AS $audit$
				BEGIN
				  RAISE EXCEPTION 'audit persistence failed';
				END
				$audit$ LANGUAGE plpgsql;
				CREATE TRIGGER reject_workflow_run_audit
				  BEFORE INSERT ON workflow_audit_events
				  FOR EACH ROW WHEN (NEW.action = 'workflow-run.enqueued')
				  EXECUTE FUNCTION reject_workflow_run_audit();`,
			);
			await expect(
				service.simulate(
					{
						workflowId: created.definition.id,
						input: { name: 'Ada' },
						fixtures: [],
					},
					context(),
				),
			).rejects.toThrow(/audit persistence failed/);
			expect(await rowCount('workflow_runs')).toBe(0);
			expect(await rowCount('workflow_run_events')).toBe(0);
		} finally {
			await database.dispose();
		}
	});

	it('executes a durable direct workflow and exposes ordered terminal evidence', async () => {
		const registry = createPlatformCapabilityRegistry();
		const fake = dependencies({ current: null });
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 1),
			cursorKey: Buffer.alloc(32, 2),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'direct-flow', name: 'Direct', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'succeeded',
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.output).toMatchObject({
			state: 'available',
			preview: { name: 'Ada' },
		});
		expect(detail.events.at(-1)?.type).toBe('run.succeeded');
		expect(await service.verifyAudit('tenant-a')).toMatchObject({
			valid: true,
		});
		await runtime.dispose();
	});

	it('persists a child correlation before waiting and resumes it without a duplicate enqueue', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 3),
			cursorKey: Buffer.alloc(32, 4),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'agent-flow', name: 'Agent flow', description: '' },
			actor,
		);
		await service.update(
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
		expect((await service.validate(agentGraph(), context())).issues).toEqual(
			[],
		);
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'waiting-agent',
		);
		expect(fake.enqueues()).toBe(1);
		expect(fake.enqueueGrants).toEqual([['catalog.items.read']]);
		expect(fake.authorizationSubjects).toEqual(['owner-1']);
		expect(
			(await service.getRunDetail('tenant-a', accepted.runId)).nodes.find(
				(node) => node.nodeId === 'agent.process',
			)?.attempts[0],
		).toMatchObject({ childId: 'child-run-1', status: 'waiting-child' });
		result.current = { name: 'Ada enriched' };
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'succeeded',
		);
		expect(fake.enqueues()).toBe(1);
		expect(
			(await service.getRun('tenant-a', accepted.runId))?.usage,
		).toMatchObject({
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
			async () =>
				(await service.getRun('tenant-a', oversized.runId))?.status ===
				'refused',
		);
		expect(
			(await service.getRun('tenant-a', oversized.runId))?.failureCode,
		).toBe('WORKFLOW_OUTPUT_LIMIT_EXCEEDED');
		await runtime.dispose();
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
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 60),
			cursorKey: Buffer.alloc(32, 61),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'agent-refusal', name: 'Agent refusal', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'refused',
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
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
		await runtime.dispose();
	});

	it('executes and refuses action nodes through the versioned public capability', async () => {
		const actionResult: { current: ActionExecutionResult | null } = {
			current: null,
		};
		const fake = actionDependencies(actionResult);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 46),
			cursorKey: Buffer.alloc(32, 47),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'action-execution', name: 'Action execution', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
			'tenant-a',
			definition.definition.id,
			2,
			actor,
			executionPermissions,
		);
		expect(
			await (
				await service.executionCapability()
			).getPublishedReference('action-execution', {
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
			async () =>
				(await service.getRunDetail('tenant-a', succeeded.runId)).nodes.find(
					(node) => node.nodeId === 'action.create',
				)?.attempts[0]?.status === 'waiting-child',
		);
		actionResult.current = {
			actionInvocationId: 'replaced-by-fake',
			status: 'succeeded',
			output: { name: 'Created' },
		};
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', succeeded.runId))?.status ===
				'succeeded',
		);
		expect(await service.getRun('tenant-a', succeeded.runId)).toMatchObject({
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
			async () =>
				(await service.getRunDetail('tenant-a', refused.runId)).nodes.find(
					(node) => node.nodeId === 'action.create',
				)?.attempts[0]?.status === 'waiting-child',
		);
		actionResult.current = {
			actionInvocationId: 'replaced-by-fake',
			status: 'refused',
			output: { code: 'ACTION_PERMISSION_DENIED' },
			code: 'ACTION_PERMISSION_DENIED',
		};
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', refused.runId))?.status === 'refused',
		);
		expect(await service.getRun('tenant-a', refused.runId)).toMatchObject({
			failureCode: 'ACTION_PERMISSION_DENIED',
			usage: { actionInvocations: 1 },
		});
		expect(fake.starts()).toBe(2);
		await runtime.dispose();
	});

	it('persists retry evidence, exhausts the policy, and counts child usage once', async () => {
		const base = dependencies({ current: null });
		const failingAgents: AgentRevisionExecutionCapability = {
			...base.agents,
			getResult: async (runId) => ({
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
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 48),
			cursorKey: Buffer.alloc(32, 49),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'retry-exhaustion', name: 'Retry exhaustion', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status === 'failed',
			4_000,
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
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
		await runtime.dispose();
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
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 56),
			cursorKey: Buffer.alloc(32, 57),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'action-retry', name: 'Action retry', description: '' },
			actor,
		);
		const graph = actionGraph(2, ['ACTION_TRANSIENT']);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status === 'failed',
			4_000,
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
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
		await runtime.dispose();
	});

	it('recovers an expired child wait after restart without enqueueing the child again', async () => {
		const databases = createWorkflowsTestProvider();
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const payloadKey = Buffer.alloc(32, 50);
		const cursorKey = Buffer.alloc(32, 51);
		const first = createWorkflowsRuntime({
			databases,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		let runId = '';
		try {
			const service = await first.service();
			const definition = await service.create(
				'tenant-a',
				{ key: 'restart-recovery', name: 'Restart recovery', description: '' },
				actor,
			);
			await service.update(
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
			await service.publish(
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
				async () =>
					(await service.getRun('tenant-a', runId))?.status === 'waiting-agent',
			);
			expect(fake.enqueues()).toBe(1);
		} finally {
			await first.dispose();
		}

		await executeAsOwner(
			databases,
			'tenant-a',
			`UPDATE workflow_runs SET lease_owner = 'crashed-worker', lease_expires_at = 1
			 WHERE tenant_id = 'tenant-a' AND id = $1`,
			[runId],
		);
		result.current = { name: 'Recovered' };
		const second = createWorkflowsRuntime({
			databases,
			capabilities: registry,
			payloadKey,
			cursorKey,
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		try {
			second.start();
			await waitFor(
				async () =>
					(await (await second.service()).getRun('tenant-a', runId))?.status ===
					'succeeded',
				4_000,
			);
			const detail = await (
				await second.service()
			).getRunDetail('tenant-a', runId);
			expect(detail.events.map((event) => event.type)).toContain(
				'run.recovered',
			);
			expect(fake.enqueues()).toBe(1);
		} finally {
			await second.dispose();
			await databases.dispose();
		}
	});

	it('persists a child observation deadline and refuses a stuck child after restart', async () => {
		const databases = createWorkflowsTestProvider();
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const payloadKey = Buffer.alloc(32, 62);
		const cursorKey = Buffer.alloc(32, 63);
		let workerNow = Date.now();
		const first = createWorkflowsRuntime({
			databases,
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
			const service = await first.service();
			const definition = await service.create(
				'tenant-a',
				{ key: 'child-deadline', name: 'Child deadline', description: '' },
				actor,
			);
			await service.update(
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
			await service.publish(
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
				async () =>
					(await service.getRun('tenant-a', runId))?.status === 'waiting-agent',
			);
			const attempt = (
				await service.getRunDetail('tenant-a', runId)
			).nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0];
			deadline = attempt?.childObservationDeadlineAt ?? 0;
			expect(deadline).toBe(workerNow + WORKFLOW_LIMITS.maxChildObservationMs);
			expect(deadline).toBeLessThanOrEqual(
				(await service.getRun('tenant-a', runId))!.queuedAt +
					WORKFLOW_LIMITS.maxLiveDurationMs,
			);
		} finally {
			await Promise.resolve(first.dispose());
		}

		workerNow = deadline;
		const second = createWorkflowsRuntime({
			databases,
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
				async () =>
					(await (await second.service()).getRun('tenant-a', runId))?.status ===
					'refused',
			);
			const detail = await (
				await second.service()
			).getRunDetail('tenant-a', runId);
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
			await databases.dispose();
		}
	});

	it('allows one worker to recover a lost lease without duplicate child settlement', async () => {
		const databases = createWorkflowsTestProvider();
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
			getResult: async (runId) =>
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
			databases,
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
			const service = await first.service();
			const definition = await service.create(
				'tenant-a',
				{ key: 'lease-contention', name: 'Lease contention', description: '' },
				actor,
			);
			await service.update(
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
			await service.publish(
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

			await executeAsOwner(
				databases,
				'tenant-a',
				`UPDATE workflow_runs SET lease_owner = 'lost-owner', lease_expires_at = 1
				 WHERE tenant_id = 'tenant-a' AND id = $1`,
				[runId],
			);
			await waitFor(() => enqueueCalls === 2);
			await waitFor(
				async () =>
					(
						await (await second.service()).getRunDetail('tenant-a', runId)
					).nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0]
						?.status === 'waiting-child',
			);
			await new Promise((resolve) => setTimeout(resolve, 600));
			result.current = { name: 'Recovered exactly once' };
			releaseFirst();
			await waitFor(
				async () =>
					(await (await second.service()).getRun('tenant-a', runId))?.status ===
					'succeeded',
				4_000,
			);
			const detail = await (
				await second.service()
			).getRunDetail('tenant-a', runId);
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
			await databases.dispose();
		}
	});

	it('deduplicates child usage and unpriced cost by child run id', async () => {
		const fake = dependencies({ current: null });
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const database = await openWorkflowsTestRepository({
			payloadCodec: createWorkflowPayloadCodec(Buffer.alloc(32, 52)),
		});
		const repository = database.repository;
		const service = new WorkflowsService(repository, {
			capabilities: registry,
			cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 53)),
		});
		const definition = await service.create(
			'tenant-a',
			{
				key: 'cost-deduplication',
				name: 'Cost deduplication',
				description: '',
			},
			actor,
		);
		await service.update(
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
		await service.publish(
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
			await repository.recordAgentUsage('tenant-a', runId, 'child-run-stable', {
				inputTokens: 4,
				outputTokens: 3,
				totalTokens: 7,
			});
		}
		expect(await repository.getRun('tenant-a', runId)).toMatchObject({
			usage: {
				inputTokens: 4,
				outputTokens: 3,
				totalTokens: 7,
				includedChildRunIds: ['child-run-stable'],
				unpricedChildRuns: 1,
			},
			cost: { unpricedChildRuns: 1 },
		});
		await database.dispose();
	});

	it('makes cancellation idempotent and lets the worker settle a queued run', async () => {
		const registry = createPlatformCapabilityRegistry();
		const fake = dependencies({ current: null });
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 11),
			cursorKey: Buffer.alloc(32, 12),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'cancel-flow', name: 'Cancel', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
		expect(
			await service.cancel('tenant-a', accepted.runId, actor),
		).toMatchObject({
			requested: true,
			status: 'cancel-requested',
		});
		expect(
			await service.cancel('tenant-a', accepted.runId, actor),
		).toMatchObject({
			requested: false,
			status: 'cancel-requested',
		});
		runtime.start();
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'cancelled',
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.events.map((event) => event.type)).toContain('run.cancelled');
		await expect(
			service.readEvents('tenant-a', accepted.runId, 10_000),
		).rejects.toThrow(/ahead/);
		expect(await service.getRun('tenant-b', accepted.runId)).toBeNull();
		await runtime.dispose();
	});

	it('observes an accepted child to terminal and discards its late result after cancellation', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 58),
			cursorKey: Buffer.alloc(32, 59),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'cancel-child', name: 'Cancel child', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'waiting-agent',
		);
		await service.cancel('tenant-a', accepted.runId, actor);
		await waitFor(async () =>
			(await service.getRunDetail('tenant-a', accepted.runId)).events.some(
				(event) => event.type === 'node.cancel.acknowledged',
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 600));
		let detail = await service.getRunDetail('tenant-a', accepted.runId);
		expect(detail.run.status).toBe('cancel-requested');
		expect(
			detail.events.filter((event) => event.type === 'node.cancel.requested'),
		).toHaveLength(1);
		result.current = { name: 'must not be routed' };
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'cancelled',
		);
		detail = await service.getRunDetail('tenant-a', accepted.runId);
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
		await runtime.dispose();
	});

	it('settles cancellation with durable evidence when child observation expires', async () => {
		const result: { current: JsonValue | null } = { current: null };
		const fake = dependencies(result);
		const registry = createPlatformCapabilityRegistry();
		registry.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
		registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
		let workerNow = Date.now();
		const runtime = createWorkflowsTestRuntime({
			capabilities: registry,
			payloadKey: Buffer.alloc(32, 66),
			cursorKey: Buffer.alloc(32, 67),
			worker: {
				pollMs: 250,
				leaseMs: 1_000,
				now: () => workerNow,
			},
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'cancel-deadline', name: 'Cancel deadline', description: '' },
			actor,
		);
		await service.update(
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
		await service.publish(
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
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'waiting-agent',
		);
		const deadline = (
			await service.getRunDetail('tenant-a', accepted.runId)
		).nodes.find((node) => node.nodeId === 'agent.process')?.attempts[0]
			?.childObservationDeadlineAt;
		expect(deadline).toEqual(expect.any(Number));
		await service.cancel('tenant-a', accepted.runId, actor);
		await waitFor(async () =>
			(await service.getRunDetail('tenant-a', accepted.runId)).events.some(
				(event) => event.type === 'node.cancel.acknowledged',
			),
		);
		workerNow = deadline!;
		await waitFor(
			async () =>
				(await service.getRun('tenant-a', accepted.runId))?.status ===
				'cancelled',
		);
		const detail = await service.getRunDetail('tenant-a', accepted.runId);
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

const routingActor = { kind: 'user', id: 'account-a', label: 'Owner' } as const;

function queuedLiveRun(
	tenantId: string,
	id: string,
	name: string,
): CreateWorkflowRunWrite {
	return {
		run: {
			id,
			tenantId,
			workflowId: `workflow-${tenantId}`,
			workflowKey: 'probe',
			workflowName: name,
			workflowRevision: 1,
			graphChecksum: 'checksum',
			graph: directGraph(),
			compiledOrder: ['input.start', 'output.done'],
			mode: 'live',
			status: 'queued',
			actor: routingActor,
			authorizationSubject: routingActor,
			origin: { kind: 'manual' },
			permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
			permissionDigest: 'digest',
			inputHash: 'sha256:input',
			inputPayloadId: '',
			idempotencyKey: `${id}-key`,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedNodes: 0,
			totalNodes: 2,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				actionInvocations: 0,
				unpricedActions: 0,
				includedChildRunIds: [],
				unpricedChildRuns: 0,
			},
			cost: { unpricedActions: 0, unpricedChildRuns: 0 },
			failureCode: null,
			queuedAt: 1_000,
			startedAt: null,
			completedAt: null,
			durationMs: null,
			cancellationRequestedAt: null,
		},
		input: { name },
		inputEvidence: {
			version: 1,
			state: 'available',
			schemaId: 'workflow.input',
			hash: 'sha256:input',
			originalByteSize: 4,
		},
	} as unknown as CreateWorkflowRunWrite;
}

describe('workflow persistence boundary', () => {
	it('keeps runs inside their tenant and refuses a connection without one', async () => {
		const database = await openWorkflowsTestRepository();
		try {
			await database.repository.createRun(
				queuedLiveRun('tenant-a', 'run-a', 'Alpha'),
			);
			await database.repository.createRun(
				queuedLiveRun('tenant-b', 'run-b', 'Beta'),
			);

			expect(await database.repository.getRun('tenant-a', 'run-b')).toBeNull();
			expect(
				(await database.repository.getRun('tenant-a', 'run-a'))?.workflowName,
			).toBe('Alpha');
			expect(await database.repository.countRuns('tenant-a')).toBe(1);

			/* Row security, not the WHERE clause: an unfiltered read under one
			   tenant still returns only the rows that tenant owns. */
			const visible = await withHandle(
				database.databases,
				'runtime',
				(handle) =>
					handle.transaction(
						(transaction) =>
							transaction.query<{ id: string }>({
								text: 'SELECT id FROM workflow_runs',
							}),
						{ access: 'read', tenantId: 'tenant-a' },
					),
			);
			expect(visible.rows.map((row) => row.id)).toEqual(['run-a']);

			await expect(
				withHandle(database.databases, 'runtime', (handle) =>
					handle.transaction(
						(transaction) =>
							transaction.query({ text: 'SELECT id FROM workflow_runs' }),
						{ access: 'read' },
					),
				),
			).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		} finally {
			await database.dispose();
		}
	});

	it('claims every queued run once, each under the tenant the poll named', async () => {
		const database = await openWorkflowsTestRepository();
		try {
			await database.repository.createRun(
				queuedLiveRun('tenant-a', 'run-a', 'Alpha'),
			);
			await database.repository.createRun(
				queuedLiveRun('tenant-b', 'run-b', 'Beta'),
			);

			const first = await database.repository.claimNext(
				'worker-1',
				2_000,
				40_000,
			);
			const second = await database.repository.claimNext(
				'worker-2',
				2_000,
				40_000,
			);
			expect([first?.id, second?.id].sort()).toEqual(['run-a', 'run-b']);
			expect(first?.tenantId).not.toBe(second?.tenantId);
			expect(
				await database.repository.claimNext('worker-3', 2_000, 40_000),
			).toBeNull();
		} finally {
			await database.dispose();
		}
	});

	it('claims a run parked on an approval only when its approval recheck is due', async () => {
		const database = await openWorkflowsTestRepository();
		const origin = { kind: 'manual' } as const;
		const evidence = {
			version: 1,
			state: 'absent',
			schemaId: 'schema.data',
			hash: 'sha256:input',
			originalByteSize: 0,
			reason: 'not-emitted',
		} as const;
		const start = (nodeId: string, attempt: number, recordedAt: number) =>
			database.repository.startAttempt(
				{
					tenantId: 'tenant-a',
					runId: 'run-a',
					nodeId,
					nodeType: nodeId === 'input.start' ? 'input' : 'output',
					attempt,
					semanticGroup: `run-a:${nodeId}`,
					sideEffectIdempotencyKey: `tenant-a:run-a:${nodeId}`,
					input: { name: 'Ada' },
					inputEvidence: evidence,
					schemaId: 'schema.data',
					recordedAt,
				},
				actor,
				origin,
			);
		const stateOf = async (nodeId: string) =>
			(await database.repository.readNodeStates('tenant-a', 'run-a')).find(
				(node) => node.nodeId === nodeId,
			);
		try {
			await database.repository.createRun(
				queuedLiveRun('tenant-a', 'run-a', 'Alpha'),
			);
			await database.repository.claimNext('worker-1', 1_000, 2_000);
			await start('input.start', 1, 1_000);
			/* A failed attempt with a retry ahead of it arms the node's recheck. */
			await database.repository.settleAttempt(
				{
					tenantId: 'tenant-a',
					runId: 'run-a',
					nodeId: 'input.start',
					attempt: 1,
					status: 'failed',
					outcomePort: null,
					outputEvidence: evidence,
					schemaId: 'schema.data',
					failureCode: 'AGENT_RUN_FAILED',
					retryClassification: 'retryable',
					selectedBackoffMs: 1_000,
					nextAttemptAt: 3_000,
					recordedAt: 1_500,
				},
				actor,
				origin,
			);
			expect((await stateOf('input.start'))?.nextAttemptAt).toBe(3_000);

			await database.repository.releaseLease('tenant-a', 'run-a', 'worker-1');
			expect(
				(await database.repository.claimNext('worker-2', 3_000, 4_000))?.id,
			).toBe('run-a');

			/* The run goes to sleep on a person, with a recheck hours away. */
			await start('output.done', 1, 3_000);
			await database.repository.markChildWaiting(
				'tenant-a',
				'run-a',
				'output.done',
				1,
				'approval',
				'approval-1',
				900_000,
				3_000,
				600_000,
			);

			/* The retried node runs again and waits on an agent child. Its armed
			   recheck fell due long ago, and nothing but an approval recheck may
			   bring a sleeping run back into the claim queue. */
			await start('input.start', 2, 3_100);
			await database.repository.markChildWaiting(
				'tenant-a',
				'run-a',
				'input.start',
				2,
				'agent',
				'child-1',
				60_000,
				3_100,
			);
			expect(await stateOf('input.start')).toMatchObject({
				status: 'waiting-child',
				nextAttemptAt: null,
			});
			expect(
				(await database.repository.getRun('tenant-a', 'run-a'))?.status,
			).toBe('waiting-approval');

			await database.repository.releaseLease('tenant-a', 'run-a', 'worker-2');
			expect(
				await database.repository.claimNext('worker-3', 5_000, 6_000),
			).toBeNull();
			expect(
				(await database.repository.claimNext('worker-4', 600_000, 620_000))?.id,
			).toBe('run-a');
		} finally {
			await database.dispose();
		}
	});

	it('denies the background role every column outside the routing set and every write', async () => {
		const database = await openWorkflowsTestRepository();
		try {
			await database.repository.createRun(
				queuedLiveRun('tenant-a', 'run-a', 'Confidential'),
			);

			const identity = await withHandle(
				database.databases,
				'background',
				(handle) =>
					handle.transaction(
						(transaction) =>
							transaction.query<{ role: string }>({
								text: 'SELECT current_user AS role',
							}),
						{ access: 'read' },
					),
			);
			expect(identity.rows[0]?.role).toBe('coreloom_background');

			for (const text of [
				'SELECT graph_json FROM workflow_runs',
				'SELECT actor_json FROM workflow_runs',
				'SELECT permission_snapshot_json FROM workflow_runs',
				'SELECT * FROM workflow_runs',
				'SELECT ciphertext FROM workflow_payloads',
				'SELECT * FROM workflow_run_events',
				'SELECT * FROM workflow_audit_events',
			]) {
				await expect(
					withHandle(database.databases, 'background', (handle) =>
						handle.transaction((transaction) => transaction.query({ text }), {
							access: 'read',
						}),
					),
				).rejects.toBeDefined();
			}

			await expect(
				withHandle(database.databases, 'background', (handle) =>
					handle.transaction(
						(transaction) =>
							transaction.execute({
								text: "UPDATE workflow_runs SET status = 'cancelled'",
							}),
						{ access: 'write' },
					),
				),
			).rejects.toBeDefined();
		} finally {
			await database.dispose();
		}
	});
});
