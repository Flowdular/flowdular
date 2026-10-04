import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import {
	CONNECTORS_CALLS_CAPABILITY,
	CONNECTORS_PERMISSIONS,
	type ConnectorCallCapability,
} from '@flowdular/module-connectors';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY_V2,
	AGENT_RUN_EXECUTION_CAPABILITY,
	createAgentRuntime,
	type AgentRuntime,
	type AgentToolContext,
} from '@flowdular/module-agents/server';
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
import { AgentHarnessError } from '../../../packages/harness/src/runtime.ts';
import { defineApiAgentTool } from '../../../packages/harness/src/tool-adapters.ts';
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
import {
	CALL_KEY_CLAIM_MS,
	createConnectorsRuntime,
	type ConnectorsRuntime,
} from '@flowdular/module-connectors/server';

const tenantId = 'tenant-consumer-connector';
const actor = userActor({
	accountId: 'owner-consumer-connector',
	email: 'owner@example.test',
});
const orderPermission = 'consumer.orders.submit';
const permissions = [
	...Object.values(WORKFLOWS_PERMISSIONS),
	CONNECTORS_PERMISSIONS.read,
	orderPermission,
];
const invocation = {
	tenantId,
	actor,
	origin: { kind: 'manual' as const },
	permissionSnapshot: permissions,
};
const inputSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['instanceId', 'orderId'],
	properties: {
		instanceId: { type: 'string', minLength: 1, maxLength: 128 },
		orderId: { type: 'string', minLength: 1, maxLength: 80 },
	},
} as const;
const outputSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['callId', 'outcome'],
	properties: {
		callId: { type: 'string' },
		outcome: { type: 'string', enum: ['succeeded', 'failed'] },
	},
} as const;

interface PinnedAction {
	readonly actionId: string;
	readonly contractVersion: number;
	readonly descriptorDigest: string;
	readonly inputSchema: JsonSchemaV1;
	readonly outputSchema: JsonSchemaV1;
	readonly workflowTemplate: {
		readonly label: string;
		readonly effect: string;
	};
}

function graph(action: PinnedAction): WorkflowGraphV1 {
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
				id: 'action.submit',
				label: 'Submit order',
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
				id: 'edge.submit',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'action.submit', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'action.submit', port: 'success' },
				target: { nodeId: 'output.done', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'action.submit', port: 'failure' },
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
			'action.submit': { x: 240, y: 0 },
			'output.done': { x: 480, y: -100 },
			'output.failed': { x: 480, y: 100 },
		},
	};
}

function orderInput(input: unknown): { instanceId: string; orderId: string } {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new AgentHarnessError(
			'INVALID_ORDER_INPUT',
			'Order input is invalid.',
		);
	}
	const value = input as Record<string, unknown>;
	if (
		typeof value.instanceId !== 'string' ||
		value.instanceId.length < 1 ||
		value.instanceId.length > 128 ||
		typeof value.orderId !== 'string' ||
		value.orderId.length < 1 ||
		value.orderId.length > 80
	) {
		throw new AgentHarnessError(
			'INVALID_ORDER_INPUT',
			'Order input is invalid.',
		);
	}
	return { instanceId: value.instanceId, orderId: value.orderId };
}

function consumerTool(
	resolveCalls: () => ConnectorCallCapability | null,
	onExecute: () => void,
	afterCall: () => void = () => {},
) {
	return defineApiAgentTool({
		id: 'consumer.orders.submit',
		endpointId: 'consumer.orders.submit',
		contractVersion: 1,
		description: 'Submit an order through the workspace connector.',
		requiredPermissions: [orderPermission],
		inputSchema,
		outputSchema,
		workflowTemplate: {
			label: 'Submit order',
			description: 'Submits one order using a consented connector instance.',
			effect: 'connector-egress',
		},
		risk: 'workspace-write',
		idempotency: 'required',
		idempotencyProtection: 'target-ledger',
		cancellation: 'cooperative',
		timeoutMs: 10_000,
		consent: {
			id: 'consumer.orders.connector-consent',
			async check(input, context) {
				const calls = resolveCalls();
				if (!calls) {
					return { granted: false, reason: 'CONNECTOR_CAPABILITY_UNAVAILABLE' };
				}
				const { instanceId } = orderInput(input);
				return (await calls.consented(context.tenantId, instanceId, 'workflow'))
					? { granted: true }
					: { granted: false, reason: 'CONNECTOR_CONSENT_MISSING' };
			},
		},
		async execute(input, context) {
			onExecute();
			const { instanceId, orderId } = orderInput(input);
			const calls = resolveCalls();
			if (!calls) {
				throw new AgentHarnessError(
					'CONNECTOR_CAPABILITY_UNAVAILABLE',
					'The connector is unavailable.',
				);
			}
			if (!context.idempotencyKey) {
				throw new AgentHarnessError(
					'CONNECTOR_IDEMPOTENCY_KEY_REQUIRED',
					'A durable connector key is required.',
				);
			}
			const result = await calls
				.call({
					tenantId: context.tenantId,
					instanceId,
					operation: 'post',
					input: { path: '/orders', body: { orderId } },
					caller: 'workflow',
					callerRef: context.runId,
					idempotencyKey: context.idempotencyKey,
					signal: context.signal,
				})
				.catch((error: unknown) => {
					if (
						error instanceof Error &&
						'code' in error &&
						error.code === 'CALL_OUTCOME_UNKNOWN'
					) {
						throw new AgentHarnessError(
							'CALL_OUTCOME_UNKNOWN',
							'The connector call outcome is unknown.',
						);
					}
					throw error;
				});
			if (result.outcome === 'refused') {
				throw new AgentHarnessError(
					'CONNECTOR_CALL_REFUSED',
					'The connector refused the order.',
				);
			}
			afterCall();
			/* A replay has no body. The module's public result is the same on both
			   sides of a handler interruption, regardless of the provider response. */
			return { callId: result.callId, outcome: result.outcome };
		},
	});
}

function toolContext(key: string): AgentToolContext {
	return {
		runId: 'workflow-run-recorded-fixture',
		tenantId,
		requestedBy: actor.id,
		invocation: 'workflow-action',
		actor,
		authorizationSubject: actor,
		permissions: new Set(permissions),
		idempotencyKey: key,
		signal: new AbortController().signal,
	};
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for the connector template workflow.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

it('WORKFLOW-CUSTOM-NODE-CONNECTOR runs a consumer template and refuses later unsafe calls', async () => {
	const shared = await openConnectorsTestDatabase();
	let server: TestServer | undefined;
	let connectors: ConnectorsRuntime | undefined;
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	try {
		server = await startTestServer(() => ({
			body: JSON.stringify({ privateResponse: 'provider-secret-response' }),
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
		connectors.definitions.register({
			...portedTestDefinition(),
			key: 'http-json-no-post',
			operations: portedTestDefinition().operations.filter(
				(operation) => operation.key !== 'post',
			),
		});
		const instance = await seedInstance(shared.repository, vault, {
			tenantId,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			credentials: {
				kind: 'api-key',
				header: 'x-api-key',
				value: 'provider-credential-secret',
			},
			allowWorkflows: true,
		});
		const foreign = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-foreign',
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowWorkflows: true,
		});
		const undeclared = await seedInstance(shared.repository, vault, {
			tenantId,
			definitionKey: 'http-json-no-post',
			baseUrl: testBaseUrl(server),
			allowWorkflows: true,
		});
		let connectorRegistry = createPlatformCapabilityRegistry();
		const calls = await connectors.calls();
		connectorRegistry.register<ConnectorCallCapability>(
			CONNECTORS_CALLS_CAPABILITY,
			calls,
		);
		let handlerCalls = 0;
		const tool = consumerTool(
			() =>
				connectorRegistry.get<ConnectorCallCapability>(
					CONNECTORS_CALLS_CAPABILITY,
				),
			() => handlerCalls++,
		);
		agents = createAgentRuntime({
			databases: shared.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [],
			tools: [tool],
			authorizeToolAccess: () => [orderPermission],
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
			payloadKey: Buffer.alloc(32, 0x45),
			cursorKey: Buffer.alloc(32, 0x46),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		await agents.prepare();
		const service = await workflows.service();
		const [action] = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedAction[];
		expect(action).toMatchObject({
			actionId: 'consumer.orders.submit',
			workflowTemplate: {
				label: 'Submit order',
				effect: 'connector-egress',
			},
			outputSchema,
		});
		if (!action) throw new Error('The consumer template is absent.');
		const definition = await service.create(
			tenantId,
			{ key: 'submit-orders', name: 'Submit orders', description: '' },
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Submit orders',
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
		agents.start();
		workflows.start();
		const enqueue = async (orderId: string, instanceId: string) =>
			service.enqueue(
				{
					workflowKey: 'submit-orders',
					input: { instanceId, orderId },
					idempotencyKey: `submit-orders:${orderId}`,
				},
				invocation,
			);
		const success = await enqueue('order-1', instance.id);
		await waitFor(
			async () =>
				(await service.getRun(tenantId, success.runId))?.status === 'succeeded',
		);
		const successDetail = await service.getRunDetail(tenantId, success.runId);
		const successfulOutput = successDetail.output.preview as {
			callId: string;
			outcome: string;
		};
		expect(successfulOutput).toEqual({
			callId: expect.any(String),
			outcome: 'succeeded',
		});
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({
			method: 'POST',
			url: '/orders',
			body: JSON.stringify({ orderId: 'order-1' }),
		});
		expect(server.requests[0]?.headers['x-api-key']).toBe(
			'provider-credential-secret',
		);
		const recorded = await shared.repository.findCall(
			tenantId,
			successfulOutput.callId,
		);
		expect(recorded).toMatchObject({
			instanceId: instance.id,
			operation: 'post',
			caller: 'workflow',
			callerRef: success.runId,
			outcome: 'succeeded',
		});
		expect(JSON.stringify(successDetail)).not.toContain(
			'provider-credential-secret',
		);
		expect(JSON.stringify(successDetail)).not.toContain(
			'provider-secret-response',
		);
		const firstKey = `${tenantId}:${success.runId}:action.submit`;
		const keyRecord = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ call_id: string }>({
					text: `SELECT call_id FROM connectors_call_keys
					       WHERE tenant_id = $1 AND idempotency_key = $2`,
					parameters: [tenantId, firstKey],
				}),
			{ tenantId, access: 'read' },
		);
		expect(keyRecord.rows).toEqual([{ call_id: successfulOutput.callId }]);

		await (
			await connectors.service()
		).consent(tenantId, actor.id, instance.id, {
			allowWorkflows: false,
			allowAgents: true,
			confirmed: true,
		});
		const refusedCases = [
			{
				orderId: 'order-no-consent',
				instanceId: instance.id,
				code: 'CONNECTOR_CONSENT_MISSING',
				status: 'refused',
			},
			{
				orderId: 'order-foreign',
				instanceId: foreign.id,
				code: 'CONNECTOR_CONSENT_MISSING',
				status: 'refused',
			},
			{
				orderId: 'order-undeclared',
				instanceId: undeclared.id,
				code: 'CONNECTOR_CALL_REFUSED',
				status: 'failed',
			},
		] as const;
		for (const scenario of refusedCases) {
			const beforeHandler = handlerCalls;
			const beforeSocket = server.requests.length;
			const refused = await enqueue(scenario.orderId, scenario.instanceId);
			try {
				await waitFor(
					async () =>
						(await service.getRun(tenantId, refused.runId))?.status ===
						scenario.status,
				);
			} catch (error) {
				const current = await service.getRunDetail(tenantId, refused.runId);
				const actionNode = current.nodes.find(
					(node) => node.nodeId === 'action.submit',
				);
				throw new Error(
					`${scenario.orderId}: ${current.run.status}/${current.run.failureCode}, action ${actionNode?.status}/${actionNode?.attempts[0]?.failureCode}`,
					{ cause: error },
				);
			}
			const detail = await service.getRunDetail(tenantId, refused.runId);
			expect(detail.run.status).toBe(scenario.status);
			expect(detail.run.failureCode).toBe(scenario.code);
			expect(server.requests).toHaveLength(beforeSocket);
			expect(handlerCalls).toBe(
				beforeHandler + (scenario.orderId === 'order-undeclared' ? 1 : 0),
			);
			expect(JSON.stringify(detail)).not.toContain(
				'provider-credential-secret',
			);
		}
		const refusedCalls = await shared.repository.listCalls(
			tenantId,
			{ instanceId: undeclared.id },
			{ direction: 'desc', after: null, limit: 10 },
		);
		expect(refusedCalls).toMatchObject([
			{
				operation: 'post',
				outcome: 'refused',
				errorClass: 'operation-unknown',
			},
		]);

		connectorRegistry = createPlatformCapabilityRegistry();
		const beforeHandler = handlerCalls;
		const beforeSocket = server.requests.length;
		const missing = await enqueue('order-missing-module', undeclared.id);
		await waitFor(
			async () =>
				(await service.getRun(tenantId, missing.runId))?.status === 'refused',
		);
		expect((await service.getRun(tenantId, missing.runId))?.failureCode).toBe(
			'CONNECTOR_CAPABILITY_UNAVAILABLE',
		);
		expect(handlerCalls).toBe(beforeHandler);
		expect(server.requests).toHaveLength(beforeSocket);
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await connectors?.dispose();
		await server?.close();
		await shared.dispose();
	}
});

it('WORKFLOW-CUSTOM-NODE-CONNECTOR-REPLAY keeps one recorded call across a handler interruption and simulates without calling it', async () => {
	const shared = await openConnectorsTestDatabase();
	let server: TestServer | undefined;
	let connectors: ConnectorsRuntime | undefined;
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	try {
		server = await startTestServer(() => ({
			body: JSON.stringify({ token: 'provider-response-private' }),
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
		const registry = createPlatformCapabilityRegistry();
		registry.register<ConnectorCallCapability>(
			CONNECTORS_CALLS_CAPABILITY,
			await connectors.calls(),
		);
		let handlerCalls = 0;
		let interrupt = true;
		const tool = consumerTool(
			() => registry.get<ConnectorCallCapability>(CONNECTORS_CALLS_CAPABILITY),
			() => handlerCalls++,
			() => {
				if (interrupt) {
					interrupt = false;
					throw new Error(
						'Recorded fixture interrupted after connector commit.',
					);
				}
			},
		);
		const input = { instanceId: instance.id, orderId: 'order-recorded' };
		const key = 'workflow:recorded-order-0001';
		await expect(tool.execute(input, toolContext(key))).rejects.toThrow(
			'Recorded fixture interrupted after connector commit.',
		);
		expect(server.requests).toHaveLength(1);
		const recorded = await shared.repository.listCalls(
			tenantId,
			{ instanceId: instance.id },
			{ direction: 'desc', after: null, limit: 10 },
		);
		expect(recorded).toHaveLength(1);
		const replay = (await tool.execute(input, toolContext(key))) as {
			callId: string;
			outcome: 'succeeded' | 'failed';
		};
		expect(replay).toEqual({
			callId: recorded[0]?.id,
			outcome: 'succeeded',
		});
		expect(server.requests).toHaveLength(1);
		expect(handlerCalls).toBe(2);
		const rawReplay = await (
			await connectors.calls()
		).call({
			tenantId,
			instanceId: instance.id,
			operation: 'post',
			input: { path: '/orders', body: { orderId: 'order-recorded' } },
			caller: 'workflow',
			idempotencyKey: key,
		});
		expect(rawReplay).toMatchObject({
			callId: recorded[0]?.id,
			outcome: 'succeeded',
			replayed: true,
			body: null,
			bodyPreview: '',
		});
		await expect(
			tool.execute({ ...input, orderId: 'another-order' }, toolContext(key)),
		).rejects.toMatchObject({ code: 'CALL_IDEMPOTENCY_CONFLICT' });
		expect(server.requests).toHaveLength(1);
		expect(JSON.stringify(replay)).not.toContain('provider-response-private');

		agents = createAgentRuntime({
			databases: shared.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [],
			tools: [tool],
			authorizeToolAccess: () => [orderPermission],
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
			payloadKey: Buffer.alloc(32, 0x47),
			cursorKey: Buffer.alloc(32, 0x48),
		});
		await agents.prepare();
		const service = await workflows.service();
		const [action] = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedAction[];
		if (!action) throw new Error('The consumer template is absent.');
		const definition = await service.create(
			tenantId,
			{ key: 'simulate-orders', name: 'Simulate orders', description: '' },
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Simulate orders',
				description: '',
				graph: graph(action),
			},
			actor,
		);
		const beforeHandler = handlerCalls;
		const fixture = {
			workflowId: definition.definition.id,
			input,
			fixtures: [
				{
					nodeId: 'action.submit',
					outcomePort: 'success',
					output: replay,
					simulatedDurationMs: 20,
				},
			],
		};
		const first = await service.simulate(fixture, invocation);
		const second = await service.simulate(fixture, invocation);
		for (const result of [first, second]) {
			expect(result.run.status).toBe('succeeded');
			expect(result.output.preview).toEqual(replay);
			expect(
				result.edges.find((edge) => edge.edgeId === 'edge.success'),
			).toMatchObject({ state: 'emitted' });
		}
		expect(handlerCalls).toBe(beforeHandler);
		expect(server.requests).toHaveLength(1);
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await connectors?.dispose();
		await server?.close();
		await shared.dispose();
	}
});

it('WORKFLOW-CUSTOM-NODE-CONNECTOR-UNKNOWN makes an uncertain consumer call terminal without another socket request', async () => {
	const shared = await openConnectorsTestDatabase();
	let server: TestServer | undefined;
	let connectors: ConnectorsRuntime | undefined;
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	try {
		server = await startTestServer(() => ({ body: '{"ok":true}' }));
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
		const calls = await connectors.calls();
		const registry = createPlatformCapabilityRegistry();
		registry.register<ConnectorCallCapability>(
			CONNECTORS_CALLS_CAPABILITY,
			calls,
		);
		let handlerCalls = 0;
		const tool = consumerTool(
			() => registry.get<ConnectorCallCapability>(CONNECTORS_CALLS_CAPABILITY),
			() => handlerCalls++,
		);
		agents = createAgentRuntime({
			databases: shared.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [],
			tools: [tool],
			authorizeToolAccess: () => [orderPermission],
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
			payloadKey: Buffer.alloc(32, 0x49),
			cursorKey: Buffer.alloc(32, 0x4a),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		await agents.prepare();
		const service = await workflows.service();
		const [action] = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedAction[];
		if (!action) throw new Error('The consumer template is absent.');
		const definition = await service.create(
			tenantId,
			{ key: 'unknown-order', name: 'Unknown order', description: '' },
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Unknown order',
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
		const input = { instanceId: instance.id, orderId: 'order-unknown' };
		const accepted = await service.enqueue(
			{
				workflowKey: 'unknown-order',
				input,
				idempotencyKey: 'unknown-order:one',
			},
			invocation,
		);
		const sideEffectKey = `${tenantId}:${accepted.runId}:action.submit`;
		const crash = vi
			.spyOn(shared.repository, 'recordCall')
			.mockRejectedValue(new Error('recorded fixture lost the call record'));
		try {
			await expect(
				tool.execute(input, toolContext(sideEffectKey)),
			).rejects.toMatchObject({ code: 'CALL_OUTCOME_UNKNOWN' });
		} finally {
			crash.mockRestore();
		}
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
			{ tenantId, access: 'write' },
		);
		agents.start();
		workflows.start();
		await waitFor(
			async () =>
				(await service.getRun(tenantId, accepted.runId))?.status === 'failed',
		);
		const detail = await service.getRunDetail(tenantId, accepted.runId);
		expect(detail.run.failureCode).toBe('CALL_OUTCOME_UNKNOWN');
		expect(
			detail.nodes.find((node) => node.nodeId === 'action.submit')?.attempts,
		).toMatchObject([
			{
				failureCode: 'CALL_OUTCOME_UNKNOWN',
				retryClassification: 'permanent',
				nextAttemptAt: null,
			},
		]);
		expect(detail.events.map((event) => event.type)).not.toContain(
			'node.retry.scheduled',
		);
		expect(server.requests).toHaveLength(1);
		expect(handlerCalls).toBe(2);
		const audit = await shared.repository.listAudit(tenantId, instance.id, 10);
		expect(audit.some((event) => event.action === 'call.outcome-unknown')).toBe(
			true,
		);
		expect(detail.output.state).toBe('absent');
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await connectors?.dispose();
		await server?.close();
		await shared.dispose();
	}
});
