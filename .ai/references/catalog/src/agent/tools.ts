import { defineApiAgentTool } from '@flowdular/sdk/harness/tool-adapters';
import {
	AgentHarnessError,
	type AgentTool,
	type AgentToolContext,
} from '@flowdular/sdk/harness/runtime';
import { agentActor, type Actor } from '@flowdular/sdk/kernel';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import type { CatalogItemKind } from '../domain/types.ts';
import type { CatalogRuntime } from '../server/runtime.ts';
import { CatalogServiceError } from '../services/catalog-service.ts';

const MAX_TOOL_ROWS = 200;
const CREATE_OPERATION = 'catalog.item.create@1';

const CATALOG_ITEM_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'id',
		'tenantId',
		'sku',
		'name',
		'kind',
		'unit',
		'basePriceMinor',
		'currency',
		'status',
		'createdAt',
	],
	properties: {
		id: { type: 'string' },
		tenantId: { type: 'string' },
		sku: { type: 'string' },
		name: { type: 'string' },
		kind: { type: 'string', enum: ['product', 'service'] },
		unit: { type: 'string' },
		basePriceMinor: { type: 'integer' },
		currency: { type: 'string' },
		status: { type: 'string', enum: ['active', 'archived'] },
		createdAt: { type: 'integer' },
	},
} as const;

function actionActor(context: AgentToolContext): Actor {
	return context.actor ?? agentActor(context);
}

function normalized(value: unknown): string {
	return typeof value === 'string'
		? value.trim().toLocaleLowerCase('en-US')
		: '';
}

function idempotencyKey(context: AgentToolContext): string {
	if (!context.idempotencyKey) {
		throw new AgentHarnessError(
			'TOOL_IDEMPOTENCY_KEY_REQUIRED',
			'The catalog create tool requires a durable idempotency key.',
		);
	}
	return context.idempotencyKey;
}

/* Tools call the catalog service and take the tenant and the actor from the
   run context, never from input; the service revalidates so a tool cannot
   bypass the endpoint's rules, every write is attributed to the run that made
   it, and list output is capped so one call cannot flood the run window. */
export function catalogAgentTools(
	runtime: CatalogRuntime,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: 'catalog.item.list',
			endpointId: 'catalog.items.list',
			contractVersion: 1,
			description:
				'List products and services of the active tenant, optionally filtered by a free-text query.',
			requiredPermissions: [CATALOG_PERMISSIONS.read],
			risk: 'read',
			idempotency: 'required',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: { query: { type: 'string', maxLength: 120 } },
			},
			outputSchema: { type: 'array', items: CATALOG_ITEM_OUTPUT_SCHEMA },
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const query = normalized(
					(input as Record<string, unknown> | null)?.query,
				);
				return (await (await runtime.service()).list(context.tenantId))
					.filter(
						(item) =>
							query === '' ||
							item.id.toLocaleLowerCase('en-US') === query ||
							item.sku.toLocaleLowerCase('en-US').includes(query) ||
							item.name.toLocaleLowerCase('en-US').includes(query),
					)
					.slice(0, MAX_TOOL_ROWS);
			},
		}),
		defineApiAgentTool({
			id: 'catalog.item.create',
			endpointId: 'catalog.items.create',
			contractVersion: 1,
			description: 'Create a product or service owned by the active tenant.',
			requiredPermissions: [CATALOG_PERMISSIONS.manage],
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['sku', 'name', 'kind', 'unit', 'basePriceMinor', 'currency'],
				properties: {
					sku: { type: 'string', maxLength: 64 },
					name: { type: 'string', maxLength: 160 },
					kind: { type: 'string', enum: ['product', 'service'] },
					unit: { type: 'string', maxLength: 24 },
					basePriceMinor: { type: 'integer' },
					currency: { type: 'string', maxLength: 3 },
				},
			},
			outputSchema: CATALOG_ITEM_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const value = (input ?? {}) as Record<string, unknown>;
				try {
					return (await runtime.service()).createIdempotent(
						context.tenantId,
						{
							sku: String(value.sku ?? ''),
							name: String(value.name ?? ''),
							kind: value.kind as CatalogItemKind,
							unit: String(value.unit ?? ''),
							basePriceMinor:
								typeof value.basePriceMinor === 'number'
									? value.basePriceMinor
									: Number.NaN,
							currency: String(value.currency ?? ''),
						},
						actionActor(context),
						{
							key: idempotencyKey(context),
							operationId: CREATE_OPERATION,
						},
					);
				} catch (error) {
					if (
						error instanceof CatalogServiceError &&
						error.code === 'CATALOG_IDEMPOTENCY_CONFLICT'
					) {
						throw new AgentHarnessError(error.code, error.message);
					}
					throw error;
				}
			},
		}),
	];
}
