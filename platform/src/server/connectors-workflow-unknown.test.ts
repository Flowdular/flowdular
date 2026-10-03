import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import { CONNECTORS_PERMISSIONS } from '@flowdular/module-connectors';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY_V2,
	AGENT_RUN_EXECUTION_CAPABILITY,
	createAgentRuntime,
	type AgentRuntime,
	type AgentToolContext,
} from '@flowdular/module-agents/server';
import {
	CALL_KEY_CLAIM_MS,
	connectorsAgentTools,
	createConnectorsRuntime,
	type ConnectorsRuntime,
} from '@flowdular/module-connectors/server';
import { WORKFLOWS_PERMISSIONS } from '@flowdular/module-workflows';
import {
	createWorkflowsRuntime,
	type WorkflowsRuntime,
} from '@flowdular/module-workflows/server';
import { expect, it, vi } from 'vitest';
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

const tenantId = 'tenant-connector-workflow';
const actor = userActor({
	accountId: 'owner-connector-workflow',
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
					maxAttempts: 3,
					retryOn: ['CALL_OUTCOME_UNKNOWN'],
					backoff: { kind: 'fixed', initialMs: 1, maximumMs: 1 },
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
			throw new Error('Timed out waiting for the connector workflow.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

it('settles an uncertain connector action without a second socket request', async () => {
	const shared = await openConnectorsTestDatabase();
	const responseToken = 'provider-response-token-unknown-0001';
	const requestMarker = 'workflow-request-marker-unknown-0001';
	let server: TestServer | undefined;
	let connectors: ConnectorsRuntime | undefined;
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	try {
		server = await startTestServer(() => ({
			body: JSON.stringify({ token: responseToken }),
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
		if (!tool) throw new Error('connectors.call was not registered.');
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
			payloadKey: Buffer.alloc(32, 0x37),
			cursorKey: Buffer.alloc(32, 0x38),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		await agents.prepare();
		const service = await workflows.service();
		const catalog = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedConnectorAction[];
		expect(catalog).toHaveLength(1);
		const [action] = catalog;
		if (!action) throw new Error('connectors.call is absent from actions.v2.');
		expect(action).toMatchObject({
			actionId: 'connectors.call',
			contractVersion: 2,
			descriptorDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
		});
		const definition = await service.create(
			tenantId,
			{ key: 'connector-unknown', name: 'Connector unknown', description: '' },
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Connector unknown',
				description: '',
				graph: graph(action),
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
		const input = {
			instanceId: instance.id,
			operation: 'post',
			input: {
				path: '/orders',
				body: { orderId: 'order-1', note: requestMarker },
			},
		};
		const accepted = await service.enqueue(
			{
				workflowKey: 'connector-unknown',
				input,
				idempotencyKey: 'connector-unknown:order-1',
			},
			invocation,
		);
		const sideEffectKey = `${tenantId}:${accepted.runId}:action.call`;
		const context: AgentToolContext = {
			runId: accepted.runId,
			tenantId,
			requestedBy: actor.id,
			invocation: 'workflow-action',
			actor,
			authorizationSubject: actor,
			permissions: new Set(permissions),
			idempotencyKey: sideEffectKey,
			signal: new AbortController().signal,
		};
		const crash = vi
			.spyOn(shared.repository, 'recordCall')
			.mockRejectedValue(new Error('simulated crash before call record'));
		try {
			await expect(tool.execute(input, context)).rejects.toThrow(
				'simulated crash before call record',
			);
		} finally {
			crash.mockRestore();
		}
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({
			method: 'POST',
			url: '/orders',
			body: JSON.stringify({ orderId: 'order-1', note: requestMarker }),
		});
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE connectors_call_keys SET claimed_at = $3
					       WHERE tenant_id = $1 AND idempotency_key = $2`,
					parameters: [
						tenantId,
						sideEffectKey,
						Date.now() - CALL_KEY_CLAIM_MS - 1_000,
					],
				}),
			{ access: 'write', tenantId },
		);
		agents.start();
		workflows.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, accepted.runId))?.status === 'failed',
		);
		const detail = await service.getRunDetail(tenantId, accepted.runId);
		expect(detail.run.failureCode).toBe('CALL_OUTCOME_UNKNOWN');
		const attempts = detail.nodes.find(
			(node) => node.nodeId === 'action.call',
		)?.attempts;
		expect(attempts).toHaveLength(1);
		expect(attempts?.[0]).toMatchObject({
			failureCode: 'CALL_OUTCOME_UNKNOWN',
			retryClassification: 'permanent',
			nextAttemptAt: null,
		});
		expect(detail.events.map((event) => event.type)).not.toContain(
			'node.retry.scheduled',
		);
		expect(server.requests).toHaveLength(1);
		expect(JSON.stringify(detail).includes(responseToken)).toBe(false);
		expect(JSON.stringify(detail).includes(requestMarker)).toBe(false);
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await connectors?.dispose();
		await server?.close();
		await shared.dispose();
	}
});
