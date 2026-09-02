import { validateToolInput, validateToolOutput } from '@coreloom/harness';
import type { AgentToolContext } from '@coreloom/harness/runtime';
import { describe, expect, it } from 'vitest';
import { catalogAgentTools } from '../src/agent/tools.ts';
import type { CatalogItem } from '../src/domain/types.ts';
import { createCatalogRuntime } from '../src/server/runtime.ts';
import { agentActor, createPlatformVariableRegistry } from '@coreloom/kernel';
import { CATALOG_PERMISSIONS } from '../src/acl/permissions.ts';
import { registerCatalogVariableSource } from '../src/domain/variables.ts';

/* execute never reads context.permissions: RBAC is enforced by the harness
   before it calls the tool, and that path is proven in modules/agents. These
   tests cover what the tool itself owns: tenant from context, reused service
   validation, and bounded output. */
function toolContext(
	tenantId: string,
	overrides: Partial<AgentToolContext> = {},
): AgentToolContext {
	return {
		runId: 'run-1',
		tenantId,
		requestedBy: 'account-1',
		idempotencyKey: 'direct-tool-call-1',
		permissions: new Set<string>(),
		signal: new AbortController().signal,
		...overrides,
	};
}

const item = (sku: string) => ({
	sku,
	name: `Item ${sku}`,
	kind: 'product' as const,
	unit: 'ea',
	basePriceMinor: 1000,
	currency: 'EUR',
});

describe('catalog agent tools', () => {
	it('registers the two catalog tools with the right permissions', () => {
		expect(
			catalogAgentTools(createCatalogRuntime({ databasePath: ':memory:' })).map(
				(tool) => ({
					id: tool.id,
					permissions: tool.requiredPermissions,
					version: tool.contractVersion,
					risk: tool.risk,
					idempotency: tool.idempotency,
					idempotencyProtection: tool.idempotencyProtection,
					cancellation: tool.cancellation,
					hasInput: tool.inputSchema !== undefined,
					hasOutput: tool.outputSchema !== undefined,
				}),
			),
		).toEqual([
			{
				id: 'catalog.item.list',
				permissions: ['catalog.items.read'],
				version: 1,
				risk: 'read',
				idempotency: 'required',
				idempotencyProtection: undefined,
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
			{
				id: 'catalog.item.create',
				permissions: ['catalog.items.manage'],
				version: 1,
				risk: 'workspace-write',
				idempotency: 'required',
				idempotencyProtection: 'target-ledger',
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
		]);
	});

	it('cooperates with cancellation before reading or writing', async () => {
		const controller = new AbortController();
		controller.abort('workflow-cancelled');
		const [list, create] = catalogAgentTools(
			createCatalogRuntime({ databasePath: ':memory:' }),
		);
		await expect(
			list!.execute({}, toolContext('tenant-a', { signal: controller.signal })),
		).rejects.toBeDefined();
		await expect(
			create!.execute(
				item('CANCELLED-1'),
				toolContext('tenant-a', { signal: controller.signal }),
			),
		).rejects.toBeDefined();
	});

	it('refuses a mutating call without a durable idempotency key', async () => {
		const create = catalogAgentTools(
			createCatalogRuntime({ databasePath: ':memory:' }),
		)[1]!;
		const { idempotencyKey: _ignored, ...withoutKey } = toolContext('tenant-a');
		await expect(
			create.execute(item('NO-KEY'), withoutKey as AgentToolContext),
		).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_KEY_REQUIRED' });
	});

	it('validates workflow action input and output against the published schemas', async () => {
		const [list, create] = catalogAgentTools(
			createCatalogRuntime({ databasePath: ':memory:' }),
		);
		expect(() =>
			validateToolInput(create!.inputSchema, {
				...item('INVALID-TENANT'),
				tenantId: 'tenant-b',
			}),
		).toThrowError(/tenantId/);
		const listed = await list!.execute({}, toolContext('tenant-a'));
		expect(() => validateToolOutput(list!.outputSchema, listed)).not.toThrow();
		const created = await create!.execute(
			item('SCHEMA-1'),
			toolContext('tenant-a'),
		);
		expect(() =>
			validateToolOutput(create!.outputSchema, created),
		).not.toThrow();
	});

	it('creates under the run tenant and ignores a tenant named in the input', async () => {
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const [, create] = catalogAgentTools(runtime);
		const created = (await create!.execute(
			{ ...item('SKU-1'), tenantId: 'tenant-b' },
			toolContext('tenant-a'),
		)) as CatalogItem;
		expect(created.tenantId).toBe('tenant-a');
		expect(runtime.service().list('tenant-a')).toHaveLength(1);
		expect(runtime.service().list('tenant-b')).toHaveLength(0);
	});

	it('preserves a workflow service actor and its configuring user in history', async () => {
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const [, create] = catalogAgentTools(runtime);
		const actor = {
			kind: 'service',
			id: 'workflow:catalog-sync',
			label: 'Catalog sync',
			configuredBy: {
				kind: 'user',
				id: 'account-owner',
				label: 'Workspace owner',
			},
		} as const;
		const created = (await create!.execute(
			item('WORKFLOW-1'),
			toolContext('tenant-a', {
				actor,
				idempotencyKey: 'workflow-run:node:attempt-1',
			}),
		)) as CatalogItem;

		expect(
			runtime.service().history('tenant-a', {
				recordId: created.id,
				limit: 10,
				cursor: null,
			}).entries[0]?.actor,
		).toEqual(actor);
		expect(runtime.service().list('tenant-b')).toEqual([]);
	});

	it('reuses the service validation so a tool cannot persist a bad currency', async () => {
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const [, create] = catalogAgentTools(runtime);
		await expect(
			create!.execute(
				{ ...item('SKU-2'), currency: 'US' },
				toolContext('tenant-a'),
			),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});

	it('bounds list output at the page cap and filters by query', async () => {
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const [list] = catalogAgentTools(runtime);
		for (let index = 0; index < 205; index += 1) {
			const context = toolContext('tenant-a');
			runtime
				.service()
				.create(
					'tenant-a',
					item(`SKU-${String(index).padStart(3, '0')}`),
					agentActor(context),
				);
		}
		expect(
			(await list!.execute(
				{},
				toolContext('tenant-a'),
			)) as readonly CatalogItem[],
		).toHaveLength(200);

		const filtered = (await list!.execute(
			{ query: 'sku-004' },
			toolContext('tenant-a'),
		)) as readonly CatalogItem[];
		expect(filtered.map((entry) => entry.sku)).toEqual(['SKU-004']);
	});

	it('resolves catalog variables through the tenant-scoped read tool', async () => {
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const tools = catalogAgentTools(runtime);
		const created = (await tools[1]!.execute(
			item('LINKED-1'),
			toolContext('tenant-a'),
		)) as CatalogItem;
		const registry = createPlatformVariableRegistry();
		registerCatalogVariableSource(registry, tools);
		const request = (tenantId: string) => ({
			tenantId,
			actor: {
				kind: 'user' as const,
				id: 'account-1',
				label: 'Account 1',
			},
			permissionSnapshot: [CATALOG_PERMISSIONS.read],
			signal: new AbortController().signal,
			bindings: { catalogItemId: created.id },
		});

		await expect(
			registry.resolve(
				'{{ catalogItem.sku }}: {{ catalogItem.name }}',
				request('tenant-a'),
			),
		).resolves.toBe('LINKED-1: Item LINKED-1');
		await expect(
			registry.resolve('{{ catalogItem.name }}', request('tenant-b')),
		).rejects.toMatchObject({ code: 'VARIABLE_VALUE_UNAVAILABLE' });
	});
});
