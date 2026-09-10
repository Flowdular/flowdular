import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';

const actor = userActor({
	accountId: 'parallel-tester',
	email: 'parallel@example.com',
});
const permissions = Object.values(WORKFLOWS_PERMISSIONS);
const context = {
	tenantId: 'parallel-test',
	actor,
	origin: { kind: 'manual' } as const,
	permissionSnapshot: permissions,
};
const actions: AgentActionExecutionCapability = {
	listWorkflowActions: async () => [
		{
			id: 'test.later',
			contractVersion: 1,
			description: 'Later branch',
			requiredPermissions: [],
			inputSchema: { type: 'object' },
			outputSchema: { type: 'object' },
			timeoutMs: 1000,
			idempotency: 'required',
			risk: 'read',
			cancellation: 'cooperative',
		},
	],
	start: vi.fn(async (request) => ({
		actionInvocationId: request.idempotencyKey,
		created: true,
	})),
	getResult: async (actionInvocationId) => ({
		actionInvocationId,
		status: 'succeeded',
		output: { branch: 'later' },
	}),
	requestCancel: async (actionInvocationId) => ({
		actionInvocationId,
		state: 'acknowledged',
	}),
};
const agents: AgentRevisionExecutionCapability = {
	listRevisions: async () => [],
	getRevision: async () => null,
	enqueueRevision: async () => {
		throw new Error('Unexpected agent call');
	},
	readEvents: async () => [],
	getResult: async () => null,
	requestCancel: async () => false,
};
const registry = createPlatformCapabilityRegistry();
registry.register(AGENT_ACTION_EXECUTION_CAPABILITY, actions);
registry.register(AGENT_RUN_EXECUTION_CAPABILITY, agents);
const runtime = createWorkflowsTestRuntime({
	capabilities: registry,
	payloadKey: Buffer.alloc(32, 7),
	cursorKey: Buffer.alloc(32, 8),
	worker: { pollMs: 250, leaseMs: 1000 },
});
beforeAll(async () => {
	await runtime.service();
	runtime.start();
});
afterAll(() => runtime.dispose());

const graph: WorkflowGraphV1 = {
	schemaVersion: 1,
	schemas: { 'data.object': { type: 'object' } },
	layout: {},
	nodes: [
		{
			id: 'input.start',
			type: 'input',
			label: 'Input',
			inputPorts: [],
			outputPorts: [{ name: 'data', schemaId: 'data.object' }],
		},
		{
			id: 'output.first',
			type: 'output',
			label: 'Early result',
			inputPorts: [{ name: 'input', schemaId: 'data.object' }],
			outputPorts: [],
			mappings: [
				{
					targetPointer: '',
					binding: { kind: 'literal', value: { branch: 'first' } },
				},
			],
		},
		{
			id: 'step.later',
			type: 'action',
			label: 'Later action',
			inputPorts: [{ name: 'input', schemaId: 'data.object' }],
			outputPorts: [
				{ name: 'success', schemaId: 'data.object' },
				{ name: 'failure', schemaId: 'data.object' },
			],
			action: { actionId: 'test.later', contractVersion: 1 },
		},
		{
			id: 'output.last',
			type: 'output',
			label: 'Later result',
			inputPorts: [{ name: 'input', schemaId: 'data.object' }],
			outputPorts: [],
		},
	],
	edges: [
		{
			id: 'edge.first',
			source: { nodeId: 'input.start', port: 'data' },
			target: { nodeId: 'output.first', port: 'input' },
		},
		{
			id: 'edge.later',
			source: { nodeId: 'input.start', port: 'data' },
			target: { nodeId: 'step.later', port: 'input' },
		},
		{
			id: 'edge.result',
			source: { nodeId: 'step.later', port: 'success' },
			target: { nodeId: 'output.last', port: 'input' },
		},
	],
};

describe('terminal output on one of multiple reachable branches', () => {
	// This characterization records an unresolved contract divergence, not the
	// desired semantics. It must become a parity regression once the terminal
	// result policy is chosen; the single run.output cannot represent both today.
	it('characterizes the current first-output/live versus last-output/simulation divergence', async () => {
		const service = await runtime.service();
		const created = await service.create(
			context.tenantId,
			{ key: 'parallel-output', name: 'Parallel output', description: '' },
			actor,
		);
		await service.update(
			context.tenantId,
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Parallel output',
				description: '',
				graph,
			},
			actor,
		);
		const simulation = await service.simulate(
			{
				workflowId: created.definition.id,
				input: {},
				fixtures: [
					{
						nodeId: 'step.later',
						output: { branch: 'later' },
						outcomePort: 'success',
					},
				],
			},
			context,
		);
		expect(simulation.run.status).toBe('succeeded');
		expect(simulation.nodes.every((node) => node.status === 'succeeded')).toBe(
			true,
		);
		expect(actions.start).not.toHaveBeenCalled();
		await service.publish(
			context.tenantId,
			created.definition.id,
			2,
			actor,
			permissions,
		);
		const accepted = await service.enqueue(
			{
				workflowKey: 'parallel-output',
				input: {},
				idempotencyKey: 'parallel-output',
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
		expect(
			live.nodes.map(({ nodeId, status }) => ({ nodeId, status })),
		).toEqual([
			{ nodeId: 'input.start', status: 'succeeded' },
			{ nodeId: 'output.first', status: 'succeeded' },
			{ nodeId: 'output.last', status: 'pending' },
			{ nodeId: 'step.later', status: 'pending' },
		]);
		expect(live.output.preview).toEqual({ branch: 'first' });
		expect(simulation.output.preview).toEqual({ branch: 'later' });
		expect(actions.start).not.toHaveBeenCalled();
	});
});
