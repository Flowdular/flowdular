import { createHash } from 'node:crypto';
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

function graph(
	action: PinnedConnectorAction,
	retryOn: readonly string[] = ['CALL_OUTCOME_UNKNOWN'],
): WorkflowGraphV1 {
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
					retryOn,
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

it.each(['recovered claim', 'in-process record failure'] as const)(
	'settles an uncertain connector action after %s without a second socket request',
	async (failureMode) => {
		const shared = await openConnectorsTestDatabase();
		const responseToken = 'provider-response-token-unknown-0001';
		const requestMarker = 'workflow-request-marker-unknown-0001';
		let server: TestServer | undefined;
		let connectors: ConnectorsRuntime | undefined;
		let agents: AgentRuntime | undefined;
		let workflows: WorkflowsRuntime | undefined;
		let restoreRecordCall: (() => void) | undefined;
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
			if (!action)
				throw new Error('connectors.call is absent from actions.v2.');
			expect(action).toMatchObject({
				actionId: 'connectors.call',
				contractVersion: 2,
				descriptorDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			});
			const definition = await service.create(
				tenantId,
				{
					key: 'connector-unknown',
					name: 'Connector unknown',
					description: '',
				},
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
			if (failureMode === 'recovered claim') {
				const crash = vi
					.spyOn(shared.repository, 'recordCall')
					.mockRejectedValue(new Error('simulated crash before call record'));
				try {
					await expect(tool.execute(input, context)).rejects.toMatchObject({
						code: 'CALL_OUTCOME_UNKNOWN',
					});
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
					{ access: 'write', tenantId },
				);
			} else {
				const crash = vi
					.spyOn(shared.repository, 'recordCall')
					.mockRejectedValue(
						new Error('simulated database persistence failure'),
					);
				restoreRecordCall = () => crash.mockRestore();
			}
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
			expect(server.requests[0]).toMatchObject({
				method: 'POST',
				url: '/orders',
				body: JSON.stringify({ orderId: 'order-1', note: requestMarker }),
			});
			const audit = (
				await shared.repository.listAudit(tenantId, instance.id, 10)
			).filter((entry) => entry.action === 'call.outcome-unknown');
			expect(audit.length).toBeGreaterThan(0);
			expect(JSON.stringify(audit)).not.toContain(requestMarker);
			expect(JSON.stringify(audit)).not.toContain(responseToken);
			expect(JSON.stringify(detail).includes(responseToken)).toBe(false);
			expect(JSON.stringify(detail).includes(requestMarker)).toBe(false);
		} finally {
			restoreRecordCall?.();
			await workflows?.dispose();
			await agents?.dispose();
			await connectors?.dispose();
			await server?.close();
			await shared.dispose();
		}
	},
);

it('retries a real workflow action with a new invocation and one stable external key', async () => {
	const shared = await openConnectorsTestDatabase();
	let agents: AgentRuntime | undefined;
	let workflows: WorkflowsRuntime | undefined;
	const observedKeys: string[] = [];
	const execute = vi.fn(async (_input: unknown, context: AgentToolContext) => {
		observedKeys.push(context.idempotencyKey ?? 'missing');
		if (observedKeys.length === 1) {
			throw new AgentHarnessError(
				'ACTION_TRANSIENT',
				'The request failed before any external effect.',
			);
		}
		return { ok: true };
	});
	try {
		const tool = defineApiAgentTool({
			id: 'test.retry',
			endpointId: 'test.retry',
			contractVersion: 1,
			description: 'Exercise a retryable workflow action.',
			requiredPermissions: [CONNECTORS_PERMISSIONS.read],
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				required: ['orderId'],
				properties: { orderId: { type: 'string' } },
				additionalProperties: false,
			},
			outputSchema: {
				type: 'object',
				required: ['ok'],
				properties: { ok: { type: 'boolean' } },
				additionalProperties: false,
			},
			execute,
		});
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
			payloadKey: Buffer.alloc(32, 0x39),
			cursorKey: Buffer.alloc(32, 0x3a),
			worker: { pollMs: 250, leaseMs: 1_000 },
		});
		await agents.prepare();
		const service = await workflows.service();
		const [action] = (await service.listActionCatalog(
			invocation,
		)) as readonly PinnedConnectorAction[];
		expect(action).toMatchObject({
			actionId: 'test.retry',
			contractVersion: 1,
			descriptorDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
		});
		if (!action)
			throw new Error('The retry action is absent from the catalog.');
		const definition = await service.create(
			tenantId,
			{ key: 'action-retry-real', name: 'Action retry', description: '' },
			actor,
		);
		await service.update(
			tenantId,
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Action retry',
				description: '',
				graph: graph(action, ['ACTION_TRANSIENT']),
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
		const input = { orderId: 'order-retry-1' };
		const accepted = await service.enqueue(
			{
				workflowKey: 'action-retry-real',
				input,
				idempotencyKey: 'action-retry-real:order-1',
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
		expect(attempts).toHaveLength(2);
		expect(attempts?.map((attempt) => attempt.status)).toEqual([
			'failed',
			'succeeded',
		]);
		expect(attempts?.[0]).toMatchObject({
			failureCode: 'ACTION_TRANSIENT',
			retryClassification: 'retryable',
		});
		expect(attempts?.[0]?.childId).toBeTruthy();
		expect(attempts?.[1]?.childId).toBeTruthy();
		expect(attempts?.[1]?.childId).not.toBe(attempts?.[0]?.childId);
		const stableKey = `${tenantId}:${accepted.runId}:action.call`;
		expect(observedKeys).toEqual([stableKey, stableKey]);
		expect(execute).toHaveBeenCalledTimes(2);

		/* Replaying each attempt must return its already settled invocation. */
		const actions = agents.actionsV2();
		for (const attempt of attempts ?? []) {
			const invocationKey =
				attempt.attempt === 1
					? stableKey
					: `workflow-action:${createHash('sha256')
							.update(stableKey)
							.update('\u0000')
							.update(String(attempt.attempt))
							.digest('hex')}`;
			expect(
				await actions.start(
					{
						actionId: action.actionId,
						contractVersion: action.contractVersion,
						input,
						idempotencyKey: invocationKey,
						sideEffectIdempotencyKey: stableKey,
					},
					{
						tenantId,
						workflowRunId: accepted.runId,
						nodeRunId: `${accepted.runId}:action.call:${attempt.attempt}`,
						actor,
						authorizationSubject: actor,
						permissionSnapshot: permissions,
						signal: new AbortController().signal,
					},
				),
			).toEqual({ actionInvocationId: attempt.childId, created: false });
		}
		expect(execute).toHaveBeenCalledTimes(2);
	} finally {
		await workflows?.dispose();
		await agents?.dispose();
		await shared.dispose();
	}
});
