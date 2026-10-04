import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import type { DatabaseAdapterLease } from '@flowdular/database';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY_V2,
	AGENT_RUN_EXECUTION_CAPABILITY,
	createAgentActionExecutionRuntime,
	createAgentRuntime,
	defineApiAgentTool,
	type AgentActionRuntime,
} from '@flowdular/module-agents/server';
import { describe, expect, it } from 'vitest';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import {
	createWorkflowsRuntime,
	type WorkflowsRuntime,
} from '../src/server/runtime.ts';
import { createWorkflowsTestProvider } from './support/database.ts';

const tenantId = 'tenant-business';
const actor = userActor({
	accountId: 'owner-business',
	email: 'owner@example.com',
});
const writePermission = 'business.records.create';
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
	writePermission,
];
const inputSchema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
	additionalProperties: false,
} as const;
const outputSchema = {
	type: 'object',
	required: ['name', 'recordId'],
	properties: { name: { type: 'string' }, recordId: { type: 'string' } },
	additionalProperties: false,
} as const;
const errorSchema = {
	type: 'object',
	required: ['code'],
	properties: { code: { type: 'string' } },
} as const;

function graph(): WorkflowGraphV1 {
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
				id: 'action.create',
				label: 'Create business record',
				type: 'action',
				inputPorts: [{ name: 'input', schemaId: 'schema.input' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.output' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				action: { actionId: 'business.records.create', contractVersion: 1 },
				failurePolicy: {
					maxAttempts: 2,
					retryOn: ['ACTION_EXECUTION_FAILED'],
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
				id: 'edge.action',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'action.create', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'action.create', port: 'success' },
				target: { nodeId: 'output.done', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'action.create', port: 'failure' },
				target: { nodeId: 'output.failed', port: 'input' },
			},
		],
		schemas: {
			'schema.input': inputSchema,
			'schema.output': outputSchema,
			'schema.error': errorSchema,
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'action.create': { x: 240, y: 0 },
			'output.done': { x: 480, y: -100 },
			'output.failed': { x: 480, y: 100 },
		},
	};
}

async function waitFor(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for custom node integration state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('custom module action across workflow and agent recovery', () => {
	it('WORKFLOW-CUSTOM-NODE-MODULE-WRITE mutates once and refuses revoked permission before the handler', async () => {
		const databases = createWorkflowsTestProvider();
		const agentHost = createAgentRuntime({
			databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [],
			providerHostAllowlist: new Set(),
			providerReadinessTtlMs: 10_000,
			providerReadinessTimeoutMs: 1_000,
			runGrantTtlMs: 1_000,
			environment: { NODE_ENV: 'test' },
		});
		const actionRuntimes: AgentActionRuntime[] = [];
		const workflowRuntimes: WorkflowsRuntime[] = [];
		let targetDatabase: DatabaseAdapterLease | undefined;
		try {
			const repository = await agentHost.repository();
			const targetMigration = await databases.acquire({
				namespace: 'business.test',
				purpose: 'migration',
			});
			try {
				await targetMigration.database.transaction(
					(transaction) =>
						transaction.executeScript(`
CREATE TABLE workflow_custom_business_records (
  tenant_id TEXT NOT NULL,
  side_effect_key TEXT NOT NULL,
  name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, side_effect_key)
);
ALTER TABLE workflow_custom_business_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_custom_business_records FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_custom_business_records_tenant_policy
  ON workflow_custom_business_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));`),
					{ access: 'write' },
				);
			} finally {
				await targetMigration.release();
			}
			targetDatabase = await databases.acquire({
				namespace: 'business.test',
				purpose: 'runtime',
			});
			const seenSideEffectKeys: string[] = [];
			let mutations = 0;
			let handlerCalls = 0;
			let livePermission = true;
			let actionClock = Date.now();
			const tool = defineApiAgentTool({
				id: 'business.records.create',
				endpointId: 'business.records.create',
				contractVersion: 1,
				description: 'Create one tenant business record.',
				requiredPermissions: [writePermission],
				inputSchema,
				outputSchema,
				workflowTemplate: {
					label: 'Create business record',
					description: 'Creates one record in the owning business module.',
					effect: 'local',
				},
				risk: 'workspace-write',
				idempotency: 'required',
				idempotencyProtection: 'target-ledger',
				cancellation: 'cooperative',
				timeoutMs: 20_000,
				async execute(input, context) {
					handlerCalls++;
					if (!context.permissions.has(writePermission)) {
						throw new Error('Business write permission is required.');
					}
					const name = (input as { name: string }).name;
					const sideEffectKey = context.idempotencyKey;
					if (!sideEffectKey) throw new Error('Missing side-effect key.');
					seenSideEffectKeys.push(sideEffectKey);
					const recordId = await targetDatabase!.database.transaction(
						async (transaction) => {
							const inserted = await transaction.query<{ record_id: string }>({
								text: `INSERT INTO workflow_custom_business_records
  (tenant_id, side_effect_key, name, record_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, side_effect_key) DO NOTHING
RETURNING record_id`,
								parameters: [
									context.tenantId,
									sideEffectKey,
									name,
									`record-${mutations + 1}`,
								],
							});
							if (inserted.rows[0]) {
								mutations++;
								return inserted.rows[0].record_id;
							}
							const existing = await transaction.query<{
								name: string;
								record_id: string;
							}>({
								text: `SELECT name, record_id
FROM workflow_custom_business_records
WHERE tenant_id = $1 AND side_effect_key = $2`,
								parameters: [context.tenantId, sideEffectKey],
							});
							if (existing.rows[0]?.name !== name) {
								throw new Error(
									'Target idempotency key belongs to another input.',
								);
							}
							return existing.rows[0].record_id;
						},
						{ tenantId: context.tenantId, access: 'write' },
					);
					if (handlerCalls === 1) {
						await new Promise<never>((_resolve, reject) => {
							context.signal.addEventListener(
								'abort',
								() => reject(new Error('Worker stopped after target commit.')),
								{ once: true },
							);
						});
					}
					return { name, recordId };
				},
			});
			const actionOptions = (workerId: string) => ({
				workerId,
				leaseMs: 1_000,
				now: () => actionClock,
				authorizeToolAccess: () => (livePermission ? [writePermission] : []),
			});
			const firstAction = createAgentActionExecutionRuntime(
				repository,
				[tool],
				actionOptions('business-action:first'),
			);
			actionRuntimes.push(firstAction);
			const registry = (actionRuntime: AgentActionRuntime) => {
				const capabilities = createPlatformCapabilityRegistry();
				capabilities.register(
					AGENT_RUN_EXECUTION_CAPABILITY,
					agentHost.revisionExecution(),
				);
				capabilities.register(
					AGENT_ACTION_EXECUTION_CAPABILITY_V2,
					actionRuntime.capabilityV2,
				);
				return capabilities;
			};
			const payloadKey = Buffer.alloc(32, 78);
			const cursorKey = Buffer.alloc(32, 79);
			const firstWorkflow = createWorkflowsRuntime({
				databases,
				capabilities: registry(firstAction),
				payloadKey,
				cursorKey,
				worker: { pollMs: 250, leaseMs: 1_000 },
			});
			workflowRuntimes.push(firstWorkflow);
			const service = await firstWorkflow.service();
			const definition = await service.create(
				tenantId,
				{
					key: 'business-record-create',
					name: 'Business record create',
					description: '',
				},
				actor,
			);
			await service.update(
				tenantId,
				{
					workflowId: definition.definition.id,
					expectedRevision: 1,
					name: 'Business record create',
					description: '',
					graph: graph(),
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
			firstWorkflow.start();
			const accepted = await service.enqueue(
				{
					workflowKey: 'business-record-create',
					input: { name: 'First' },
					idempotencyKey: 'business-create:first',
				},
				{
					tenantId,
					actor,
					origin: { kind: 'manual' },
					permissionSnapshot: permissions,
				},
			);
			await waitFor(
				async () =>
					(await service.getRunDetail(tenantId, accepted.runId)).nodes.find(
						(node) => node.nodeId === 'action.create',
					)?.attempts[0]?.status === 'waiting-child',
			);
			firstAction.start();
			await waitFor(() => mutations === 1);
			expect(await service.getRun(tenantId, accepted.runId)).toMatchObject({
				status: 'running',
			});
			await firstAction.dispose();
			await firstWorkflow.dispose();
			actionClock += 2_000;

			const recoveredAction = createAgentActionExecutionRuntime(
				repository,
				[tool],
				actionOptions('business-action:recovered'),
			);
			actionRuntimes.push(recoveredAction);
			const recoveredWorkflow = createWorkflowsRuntime({
				databases,
				capabilities: registry(recoveredAction),
				payloadKey,
				cursorKey,
				worker: { pollMs: 250, leaseMs: 1_000 },
			});
			workflowRuntimes.push(recoveredWorkflow);
			recoveredAction.start();
			recoveredWorkflow.start();
			const recoveredService = await recoveredWorkflow.service();
			await waitFor(
				async () =>
					(await recoveredService.getRun(tenantId, accepted.runId))?.status ===
					'succeeded',
			);
			const detail = await recoveredService.getRunDetail(
				tenantId,
				accepted.runId,
			);
			expect(
				detail.nodes.find((node) => node.nodeId === 'action.create'),
			).toMatchObject({ attempts: [{ status: 'succeeded' }] });
			expect(detail.output.preview).toEqual({
				name: 'First',
				recordId: 'record-1',
			});
			expect(seenSideEffectKeys).toEqual([
				`${tenantId}:${accepted.runId}:action.create`,
				`${tenantId}:${accepted.runId}:action.create`,
			]);
			expect(handlerCalls).toBe(2);
			expect(mutations).toBe(1);
			const foreignRecords = await targetDatabase.database.transaction(
				(transaction) =>
					transaction.query({
						text: 'SELECT record_id FROM workflow_custom_business_records',
					}),
				{ tenantId: 'another-tenant', access: 'read' },
			);
			expect(foreignRecords.rows).toEqual([]);

			livePermission = false;
			const callsBeforeRefusal = handlerCalls;
			const refused = await recoveredService.enqueue(
				{
					workflowKey: 'business-record-create',
					input: { name: 'Denied' },
					idempotencyKey: 'business-create:denied',
				},
				{
					tenantId,
					actor,
					origin: { kind: 'manual' },
					permissionSnapshot: permissions,
				},
			);
			await waitFor(
				async () =>
					(await recoveredService.getRun(tenantId, refused.runId))?.status ===
					'refused',
			);
			const refusal = await recoveredService.getRunDetail(
				tenantId,
				refused.runId,
			);
			expect(
				refusal.nodes.find((node) => node.nodeId === 'action.create'),
			).toMatchObject({
				attempts: [{ failureCode: 'ACTION_PERMISSION_REVOKED' }],
			});
			expect(handlerCalls).toBe(callsBeforeRefusal);
			expect(mutations).toBe(1);
		} finally {
			for (const runtime of workflowRuntimes.reverse()) {
				await runtime.dispose();
			}
			for (const runtime of actionRuntimes.reverse()) {
				await runtime.dispose();
			}
			await targetDatabase?.release();
			await agentHost.dispose();
			await databases.dispose();
		}
	});
});
