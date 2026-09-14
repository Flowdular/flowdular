import { userActor } from '@flowdular/kernel';
import { describe, expect, it } from 'vitest';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';
import { executionCapabilities } from './support/harness.ts';

const actor = userActor({ accountId: 'owner-1', email: 'owner@example.com' });
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
];
const TERMINAL = new Set(['succeeded', 'failed', 'refused', 'cancelled']);

function graph(): WorkflowGraphV1 {
	const schema = {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' } },
	} as const;
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

describe('workflow run detail snapshot', () => {
	it('rebuilds a consistent projection while the worker commits transitions', async () => {
		const runtime = createWorkflowsTestRuntime({
			capabilities: executionCapabilities(),
			payloadKey: Buffer.alloc(32, 51),
			cursorKey: Buffer.alloc(32, 52),
			worker: { pollMs: 20, leaseMs: 1_000 },
		});
		const service = await runtime.service();
		const definition = await service.create(
			'tenant-a',
			{ key: 'snapshot-flow', name: 'Snapshot', description: '' },
			actor,
		);
		await service.update(
			'tenant-a',
			{
				workflowId: definition.definition.id,
				expectedRevision: 1,
				name: 'Snapshot',
				description: '',
				graph: graph(),
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
		const failures: unknown[] = [];
		for (let index = 0; index < 12; index += 1) {
			const accepted = await service.enqueue(
				{
					workflowKey: 'snapshot-flow',
					input: { name: `Ada ${index}` },
					idempotencyKey: `snapshot-flow:${index}`,
				},
				{
					tenantId: 'tenant-a',
					actor,
					origin: { kind: 'manual' },
					permissionSnapshot: permissions,
				},
			);
			const deadline = Date.now() + 20_000;
			const reader = async () => {
				for (;;) {
					let status: string | undefined;
					try {
						status = (await service.getRunDetail('tenant-a', accepted.runId))
							.run.status;
					} catch (error) {
						failures.push(error);
					}
					if ((status && TERMINAL.has(status)) || Date.now() > deadline) return;
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			};
			await Promise.all(Array.from({ length: 4 }, reader));
			expect(failures).toEqual([]);
			expect((await service.getRun('tenant-a', accepted.runId))?.status).toBe(
				'succeeded',
			);
		}
		await runtime.dispose();
	});
});
