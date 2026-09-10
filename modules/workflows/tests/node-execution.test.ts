import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import {
	AGENT_RUN_EXECUTION_CAPABILITY,
	AGENT_ACTION_EXECUTION_CAPABILITY,
	type AgentRevisionExecutionCapability,
	type AgentActionExecutionCapability,
} from '@flowdular/module-agents/server';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	emptyWorkflowGraph,
	replaceWorkflowNode,
	type WorkflowNodeType,
} from '../src/client/canvas-model.ts';
import { addConnectedNode } from '../src/client/connected-node.ts';
import type { JsonValue, WorkflowGraphV1 } from '../src/domain/types.ts';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';

const actor = userActor({
	accountId: 'node-tester',
	email: 'node-tester@example.com',
});
const permissions = [
	...Object.values(WORKFLOWS_PERMISSIONS),
	'agents.definitions.read',
	'agents.runs.execute',
	'agents.runs.read',
];
const context = {
	tenantId: 'node-test',
	actor,
	origin: { kind: 'manual' } as const,
	permissionSnapshot: permissions,
};
const registry = createPlatformCapabilityRegistry();
const childResults = new Map<string, JsonValue>();
let externalCalls = 0;
const agents: AgentRevisionExecutionCapability = {
	listRevisions: async () => [
		{
			agentId: 'test-agent',
			revision: 1,
			name: 'Test agent',
			status: 'active',
			supportsStructuredOutput: true,
			allowedTools: [],
		},
	],
	getRevision: async () => ({
		agentId: 'test-agent',
		revision: 1,
		name: 'Test agent',
		status: 'active',
		supportsStructuredOutput: true,
		allowedTools: [],
	}),
	enqueueRevision: async (request) => {
		externalCalls++;
		const id = request.idempotencyKey;
		childResults.set(
			id,
			request.outputContract.kind === 'json-schema' &&
				request.outputContract.name === 'workflow-agent-decision'
				? { decision: 'pass', data: { name: 'Ada' } }
				: { name: 'Ada' },
		);
		return { runId: id, created: true };
	},
	readEvents: async () => [],
	getResult: async (runId) => ({
		runId,
		status: 'succeeded',
		output: null,
		structuredOutput: childResults.get(runId)!,
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		failureCode: null,
		completedAt: Date.now(),
	}),
	requestCancel: async () => true,
};
const actions: AgentActionExecutionCapability = {
	listWorkflowActions: async () => [
		{
			id: 'test.echo',
			contractVersion: 1,
			description: 'Echo',
			requiredPermissions: [],
			inputSchema: { type: 'object' },
			outputSchema: { type: 'object' },
			timeoutMs: 1000,
			idempotency: 'required',
			risk: 'read',
			cancellation: 'cooperative',
		},
	],
	start: async (request) => {
		externalCalls++;
		childResults.set(request.idempotencyKey, request.input);
		return { actionInvocationId: request.idempotencyKey, created: true };
	},
	getResult: async (actionInvocationId) => ({
		actionInvocationId,
		status: 'succeeded',
		output: childResults.get(actionInvocationId)!,
	}),
	requestCancel: async (actionInvocationId) => ({
		actionInvocationId,
		state: 'acknowledged',
	}),
};
registry.register(AGENT_RUN_EXECUTION_CAPABILITY, agents);
registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, actions);
const runtime = createWorkflowsTestRuntime({
	capabilities: registry,
	payloadKey: Buffer.alloc(32, 3),
	cursorKey: Buffer.alloc(32, 4),
	worker: { pollMs: 250, leaseMs: 1000 },
});
beforeAll(async () => {
	await runtime.service();
	runtime.start();
});
afterAll(() => runtime.dispose());

function graphFor(type: WorkflowNodeType): {
	graph: WorkflowGraphV1;
	nodeId: string;
} {
	const input = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
	if (type === 'input' || type === 'output')
		return addConnectedNode(input.graph, 'output', 'Output', {
			source: { nodeId: input.nodeId, port: 'data' },
			position: { x: 500, y: 100 },
		})!;
	const added = addWorkflowNode(input.graph, type, type);
	let graph = added.graph;
	const node = graph.nodes.find((entry) => entry.id === added.nodeId)!;
	if (node.type === 'agent' || node.type === 'agent-decision')
		graph = replaceWorkflowNode(graph, {
			...node,
			agent: { agentId: 'test-agent', revision: 1 },
		});
	if (node.type === 'action')
		graph = replaceWorkflowNode(graph, {
			...node,
			action: { actionId: 'test.echo', contractVersion: 1 },
		});
	if (node.type === 'gate')
		graph = replaceWorkflowNode(graph, {
			...node,
			expression: { op: 'exists', value: { op: 'path', pointer: '/name' } },
		});
	graph = connectWorkflowNodes(
		graph,
		input.nodeId,
		'data',
		node.id,
		node.inputPorts[0]!.name,
	);
	const output = addConnectedNode(graph, 'output', 'Output', {
		source: { nodeId: node.id, port: node.outputPorts[0]!.name },
		position: { x: 500, y: 100 },
	})!;
	return { graph: output.graph, nodeId: node.id };
}

describe('every built-in node through simulation and the durable live worker', () => {
	for (const type of [
		'input',
		'agent',
		'agent-decision',
		'gate',
		'validator',
		'action',
		'merge',
		'output',
	] as const) {
		it(type + ' preserves its declared data and outcome contract', async () => {
			const service = await runtime.service();
			const { graph, nodeId } = graphFor(type);
			const created = await service.create(
				context.tenantId,
				{ key: 'node-' + type, name: type, description: '' },
				actor,
			);
			await service.update(
				context.tenantId,
				{
					workflowId: created.definition.id,
					expectedRevision: 1,
					name: type,
					description: '',
					graph,
				},
				actor,
			);
			const callsBefore = externalCalls;
			const simulated = await service.simulate(
				{
					workflowId: created.definition.id,
					input: { name: 'Ada' },
					fixtures: ['agent', 'agent-decision', 'action'].includes(type)
						? [
								{
									nodeId,
									outcomePort: type === 'agent-decision' ? 'pass' : 'success',
									output: { name: 'Ada' },
								},
							]
						: [],
				},
				context,
			);
			expect(externalCalls).toBe(callsBefore);
			expect(simulated.run.status).toBe('succeeded');
			const expected = type === 'merge' ? [{ name: 'Ada' }] : { name: 'Ada' };
			expect(simulated.output.preview).toEqual(expected);
			await service.publish(
				context.tenantId,
				created.definition.id,
				2,
				actor,
				permissions,
			);
			const accepted = await service.enqueue(
				{
					workflowKey: 'node-' + type,
					input: { name: 'Ada' },
					idempotencyKey: 'node-' + type,
				},
				context,
			);
			await vi.waitFor(
				async () =>
					expect(
						(await service.getRun(context.tenantId, accepted.runId))?.status,
					).toBe('succeeded'),
				{ timeout: 5000, interval: 50 },
			);
			const live = await service.getRunDetail(context.tenantId, accepted.runId);
			expect(live.output.preview).toEqual(expected);
			expect(live.nodes.every((node) => node.status === 'succeeded')).toBe(
				true,
			);
		});
	}
	it('reads an indirect ancestor mapping in simulation and live execution', async () => {
		const service = await runtime.service();
		let { graph } = graphFor('gate');
		graph = {
			...graph,
			nodes: graph.nodes.map((node) =>
				node.type === 'output'
					? {
							...node,
							mappings: [
								{
									targetPointer: '/name',
									binding: {
										kind: 'path',
										sourceNodeId: 'input.n1',
										sourcePort: 'data',
										pointer: '/name',
									},
								},
							],
						}
					: node,
			),
		};
		const created = await service.create(
			context.tenantId,
			{ key: 'ancestor-mapping', name: 'Mapping', description: '' },
			actor,
		);
		await service.update(
			context.tenantId,
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Mapping',
				description: '',
				graph,
			},
			actor,
		);
		const simulated = await service.simulate(
			{
				workflowId: created.definition.id,
				input: { name: 'Ada' },
				fixtures: [],
			},
			context,
		);
		expect(simulated.output.preview).toEqual({ name: 'Ada' });
		await service.publish(
			context.tenantId,
			created.definition.id,
			2,
			actor,
			permissions,
		);
		const accepted = await service.enqueue(
			{
				workflowKey: 'ancestor-mapping',
				input: { name: 'Ada' },
				idempotencyKey: 'ancestor-mapping',
			},
			context,
		);
		await vi.waitFor(
			async () =>
				expect(
					(await service.getRun(context.tenantId, accepted.runId))?.status,
				).toBe('succeeded'),
			{ timeout: 5000, interval: 50 },
		);
		expect(
			(await service.getRunDetail(context.tenantId, accepted.runId)).output
				.preview,
		).toEqual({ name: 'Ada' });
	});
});
