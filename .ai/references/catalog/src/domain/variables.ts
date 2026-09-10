import type { VariableSource } from '@flowdular/sdk/contracts';
import type {
	AgentTool,
	AgentToolContext,
} from '@flowdular/sdk/harness/runtime';
import {
	VariableResolutionError,
	type PlatformVariableRegistry,
	type VariableSourceResolutionContext,
} from '@flowdular/sdk/kernel';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import type { CatalogItem } from './types.ts';

export const CATALOG_VARIABLE_SOURCE: VariableSource = {
	id: 'catalog.items',
	variables: [
		{
			key: 'catalogItem.name',
			label: 'Catalog item name',
			kind: 'text',
			scope: CATALOG_PERMISSIONS.read,
		},
		{
			key: 'catalogItem.sku',
			label: 'Catalog item SKU',
			kind: 'identifier',
			scope: CATALOG_PERMISSIONS.read,
		},
		{
			key: 'catalogItem.priceMinor',
			label: 'Catalog item price in minor units',
			kind: 'money',
			scope: CATALOG_PERMISSIONS.read,
		},
		{
			key: 'catalogItem.currency',
			label: 'Catalog item currency',
			kind: 'identifier',
			scope: CATALOG_PERMISSIONS.read,
		},
	],
};

function toolContext(
	context: VariableSourceResolutionContext,
): AgentToolContext {
	return {
		runId:
			context.actor.kind === 'agent'
				? context.actor.runId!
				: `variable:${context.actor.kind}:${context.actor.id}`,
		tenantId: context.tenantId,
		requestedBy: context.actor.id,
		permissions: new Set(context.permissionSnapshot),
		signal: context.signal,
	};
}

/* catalog.item.list is the module-owned public read tool. Its exact-id query
   is bounded before paging, so the resolver never scans or opens catalog.db. */
export function registerCatalogVariableSource(
	registry: PlatformVariableRegistry,
	tools: readonly AgentTool[],
): void {
	const list = tools.find((tool) => tool.id === 'catalog.item.list');
	if (!list || !list.requiredPermissions.includes(CATALOG_PERMISSIONS.read)) {
		throw new Error(
			'catalog.item.list must require catalog.items.read before variables can be registered.',
		);
	}
	const requiredBindings = Object.fromEntries(
		CATALOG_VARIABLE_SOURCE.variables.map((variable) => [
			variable.key,
			['catalogItemId'] as const,
		]),
	);
	registry.register(CATALOG_VARIABLE_SOURCE, {
		requiredBindings,
		resolve: async (context) => {
			if (
				!list.requiredPermissions.every((permission) =>
					context.permissionSnapshot.includes(permission),
				)
			) {
				throw new VariableResolutionError(
					'FORBIDDEN_TEMPLATE_VARIABLE',
					'The variable source is unavailable to this actor.',
				);
			}
			const rows = (await list.execute(
				{ query: context.bindings.catalogItemId },
				toolContext(context),
			)) as readonly CatalogItem[];
			const item = rows.find(
				(candidate) => candidate.id === context.bindings.catalogItemId,
			);
			if (!item) {
				throw new VariableResolutionError(
					'VARIABLE_VALUE_UNAVAILABLE',
					'A variable value is unavailable.',
				);
			}
			return {
				'catalogItem.name': item.name,
				'catalogItem.sku': item.sku,
				'catalogItem.priceMinor': String(item.basePriceMinor),
				'catalogItem.currency': item.currency,
			};
		},
	});
}
