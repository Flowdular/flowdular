import { createPlatformCapabilityRegistry, userActor } from '@flowdular/kernel';
import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { createWorkflowCursorCodec } from '../src/services/cursor-codec.ts';
import { WorkflowsService } from '../src/services/workflows-service.ts';
import { openWorkflowsTestRepository } from './support/database.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';

async function fixture() {
	const database = await openWorkflowsTestRepository();
	const service = new WorkflowsService(database.repository, {
		capabilities: createPlatformCapabilityRegistry(),
		cursorCodec: createWorkflowCursorCodec(Buffer.alloc(32, 7)),
	});
	return { database, service };
}

const actor = userActor({ accountId: 'account-1', email: 'owner@example.com' });

const graph: WorkflowGraphV1 = {
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
			id: 'edge.complete',
			source: { nodeId: 'input.start', port: 'data' },
			target: { nodeId: 'output.done', port: 'input' },
		},
	],
	schemas: {
		'schema.data': {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' } },
		},
	},
	layout: {
		'input.start': { x: 0, y: 0 },
		'output.done': { x: 300, y: 0 },
	},
};

describe('workflows.core', () => {
	it('exports its validated identity', async () => {
		expect(moduleDefinition.manifest.id).toBe('workflows.core');
	});

	it('isolates definitions by trusted tenant id', async () => {
		const { database, service } = await fixture();
		await service.create(
			'tenant-a',
			{ key: 'alpha-flow', name: 'Alpha', description: '' },
			actor,
		);
		await service.create(
			'tenant-b',
			{ key: 'beta-flow', name: 'Beta', description: '' },
			actor,
		);
		expect(
			(await service.list('tenant-a')).map((record) => record.name),
		).toEqual(['Alpha']);
		expect(
			(await service.list('tenant-b')).map((record) => record.name),
		).toEqual(['Beta']);
		await database.dispose();
	});

	it('accepts tenant workflow slugs and rejects platform dotted ids', async () => {
		const { database, service } = await fixture();
		expect(
			(
				await service.create(
					'tenant-a',
					{ key: 'catalog-enrichment', name: 'Catalog', description: '' },
					actor,
				)
			).definition.key,
		).toBe('catalog-enrichment');
		await expect(
			service.create(
				'tenant-a',
				{ key: 'catalog.enrichment', name: 'Catalog 2', description: '' },
				actor,
			),
		).rejects.toThrow(/lowercase slug/);
		await database.dispose();
	});

	it('persists deterministic simulation attempts, edges, events and output evidence', async () => {
		const { database, service } = await fixture();
		const created = await service.create(
			'tenant-a',
			{ key: 'simulation-flow', name: 'Simulation', description: '' },
			actor,
		);
		await service.update(
			'tenant-a',
			{
				workflowId: created.definition.id,
				expectedRevision: 1,
				name: 'Simulation',
				description: '',
				graph,
			},
			actor,
		);
		const detail = await service.simulate(
			{
				workflowId: created.definition.id,
				input: { name: 'Ada' },
				fixtures: [],
			},
			{
				tenantId: 'tenant-a',
				actor,
				origin: { kind: 'manual' },
				permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
			},
		);
		expect(detail.run.status).toBe('succeeded');
		expect(detail.nodes).toHaveLength(2);
		expect(detail.edges).toMatchObject([{ state: 'emitted' }]);
		expect(detail.output).toMatchObject({
			state: 'available',
			preview: { name: 'Ada' },
		});
		expect(detail.events.map((event) => event.sequence)).toEqual(
			detail.events.map((_, index) => index + 1),
		);
		expect(
			detail.events.every((event) => event.virtualOffsetMs !== undefined),
		).toBe(true);
		await database.dispose();
	});
});
