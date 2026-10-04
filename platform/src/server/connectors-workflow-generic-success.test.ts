import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import { CONNECTORS_PERMISSIONS } from '@flowdular/module-connectors';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY_V2,
	AGENT_RUN_EXECUTION_CAPABILITY,
	createAgentRuntime,
	type AgentRuntime,
} from '@flowdular/module-agents/server';
import {
	connectorsAgentTools,
	createConnectorsRuntime,
	type ConnectorsRuntime,
} from '@flowdular/module-connectors/server';
import { WORKFLOWS_PERMISSIONS } from '@flowdular/module-workflows';
import {
	createWorkflowsRuntime,
	type WorkflowsRuntime,
} from '@flowdular/module-workflows/server';
import { expect, it } from 'vitest';
import type {
	JsonSchemaV1,
	WorkflowGraphV1,
} from '../../../modules/workflows/src/domain/types.ts';
import { openConnectorsTestDatabase } from '../../../modules/connectors/tests/support/database.ts';
import {
	TEST_DEFINITION_KEY,
	TEST_LIMITS,
	portedTestDefinition,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testConnect,
	testResolver,
	testVault,
	type TestServer,
} from '../../../modules/connectors/tests/support/harness.ts';

const tenantId = 'tenant-generic-workflow';
const actor = userActor({
	accountId: 'owner-generic-workflow',
	email: 'owner@example.test',
});
const permissions = [
	...Object.values(WORKFLOWS_PERMISSIONS),
	CONNECTORS_PERMISSIONS.read,
];
const invocation = {
	tenantId,
	actor,
	origin: { kind: 'manual' as const },
	permissionSnapshot: permissions,
};

interface PinnedConnectorAction {
	readonly actionId: string;
	readonly contractVersion: number;
	readonly descriptorDigest: string;
	readonly inputSchema: JsonSchemaV1;
	readonly outputSchema: JsonSchemaV1;
}

function graph(action: PinnedConnectorAction): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'schema.input' }],
			},
			{
				id: 'action.call',
				label: 'Call connector',
				type: 'action',
				inputPorts: [{ name: 'input', schemaId: 'schema.input' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.output' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				action: {
					actionId: action.actionId,
					contractVersion: action.contractVersion,
					descriptorDigest: action.descriptorDigest,
				},
				failurePolicy: {
					maxAttempts: 1,
					retryOn: [],
					backoff: { kind: 'fixed', initialMs: 0, maximumMs: 0 },
					onExhausted: 'fail-run',
				},
			},
			{
				id: 'output.done',
				label: 'Done',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.output' }],
				outputPorts: [],
			},
			{
				id: 'output.failed',
				label: 'Failed',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.error' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.call',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'action.call', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'action.call', port: 'success' },
				target: { nodeId: 'output.done', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'action.call', port: 'failure' },
				target: { nodeId: 'output.failed', port: 'input' },
			},
		],
		schemas: {
			'schema.input': action.inputSchema,
			'schema.output': action.outputSchema,
			'schema.error': {
				type: 'object',
				required: ['code'],
				properties: { code: { type: 'string' } },
			},
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'action.call': { x: 240, y: 0 },
			'output.done': { x: 480, y: -100 },
			'output.failed': { x: 480, y: 100 },
		},
	};
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for the generic connector workflow.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

it('runs generic connectors.call v2 with nullable status and errorClass through a completed workflow', async () => {
	const shared = await openConnectorsTestDatabase();
	let server: TestServer | undefined;
	let connectors: ConnectorsRuntime | undefined;
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	try {
		server = await startTestServer(() => ({
			status: 200,
			body: JSON.stringify({ providerValue: 'private-response' }),
		}));
		const vault = testVault();
		connectors = createConnectorsRuntime({
			databases: shared.databases,
			repository: shared.repository,
			vault,
			limits: () => TEST_LIMITS,
			hostResolver: testResolver(),
			connect: testConnect(),
		});
		connectors.definitions.register(portedTestDefinition());
		const instance = await seedInstance(shared.repository, vault, {
			tenantId,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowWorkflows: true,
		});
		const [tool] = connectorsAgentTools(connectors);
		if (!tool) throw new Error('The generic connector action is absent.');
		agents = createAgentRuntime({
			databases: shared.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [],
			tools: [tool],
			authorizeToolAccess: () => [CONNECTORS_PERMISSIONS.read],
			providerHostAllowlist: new Set(),
			providerReadinessTtlMs: 10_000,
			providerReadinessTimeoutMs: 1_000,
			runGrantTtlMs: 1_000,
			environment: { NODE_ENV: 'test' },
		});
		const capabilities = createPlatformCapabilityRegistry();
		capabilities.register(
			AGENT_RUN_EXECUTION_CAPABILITY,
			agents.revisionExecution(),
		);
		capabilities.register(
			AGENT_ACTION_EXECUTION_CAPABILITY_V2,
			agents.actionsV2(),
		);
		workflows = createWorkflowsRuntime({
			databases: shared.databases,
			capabilities,
			payloadKey: Buffer.alloc(32, 0x51),
			cursorKey: Buffer.alloc(32, 0x52),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		await agents.prepare();
		const service = await workflows.service();
		const [action] = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedConnectorAction[];
		expect(action).toMatchObject({
			actionId: 'connectors.call',
			contractVersion: 2,
			outputSchema: {
				properties: {
					status: { type: ['integer', 'null'] },
					errorClass: { type: ['string', 'null'] },
				},
			},
		});
		if (!action)
			throw new Error('The generic action is absent from the catalog.');
		const actionGraph = graph(action);
		expect(await service.validate(actionGraph, invocation)).toMatchObject({
			valid: true,
			issues: [],
		});
		const definition = await service.create(
			tenantId,
			{
				key: 'generic-connector-success',
				name: 'Generic connector',
				description: '',
			},
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Generic connector',
				description: '',
				graph: actionGraph,
			},
			actor,
		);
		await service.publish(
			tenantId,
			definition.definition.id,
			2,
			actor,
			permissions,
		);
		const accepted = await service.enqueue(
			{
				workflowKey: 'generic-connector-success',
				input: {
					instanceId: instance.id,
					operation: 'post',
					input: { path: '/orders', body: { orderId: 'order-1' } },
				},
				idempotencyKey: 'generic-connector-success:order-1',
			},
			invocation,
		);
		agents.start();
		workflows.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, accepted.runId))?.status ===
				'succeeded',
		);
		const detail = await service.getRunDetail(tenantId, accepted.runId);
		const attempts = detail.nodes.find(
			(node) => node.nodeId === 'action.call',
		)?.attempts;
		expect(attempts).toMatchObject([
			{ status: 'succeeded', outcomePort: 'success', failureCode: null },
		]);
		const childId = attempts?.[0]?.childId;
		if (!childId) throw new Error('The successful action has no child id.');
		const result = await agents.actionsV2().getResult(childId, {
			tenantId,
			workflowRunId: accepted.runId,
			actor,
			authorizationSubject: actor,
			permissionSnapshot: permissions,
		});
		expect(result).toMatchObject({
			status: 'succeeded',
			output: {
				callId: expect.any(String),
				outcome: 'succeeded',
				status: 200,
				errorClass: null,
			},
		});
		expect(
			detail.nodes.find((node) => node.nodeId === 'output.done'),
		).toMatchObject({
			status: 'succeeded',
		});
		expect(server.requests).toMatchObject([
			{ method: 'POST', url: '/orders', body: '{"orderId":"order-1"}' },
		]);
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await connectors?.dispose();
		await server?.close();
		await shared.dispose();
	}
});
