import type { DataClassDeclaration } from '@flowdular/sdk/kernel';
import type { CatalogService } from './catalog-service.ts';

/** The class ids are `catalog.core.<key>`. */
export const CATALOG_DATA_CLASS_KEYS = {
	items: 'items',
	history: 'history',
	idempotencyLedger: 'idempotency-ledger',
} as const;

/**
 * What this module holds, for the workspace's data class catalogue. Items and
 * their history are master data: no retention period, no sweep, no erasure. A
 * row leaves only when a person deletes it. The idempotency ledger is the
 * replay guard of the mutating tools and workflow actions; it stays out of the
 * export because the item it points at is already in the items class.
 */
export function catalogDataClasses(
	service: () => Promise<CatalogService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: CATALOG_DATA_CLASS_KEYS.items,
			label: 'Catalog items',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportItemsTo(tenantId, sink),
		},
		{
			key: CATALOG_DATA_CLASS_KEYS.history,
			label: 'Catalog item history',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportHistoryTo(tenantId, sink),
		},
		{
			key: CATALOG_DATA_CLASS_KEYS.idempotencyLedger,
			label: 'Catalog idempotency ledger',
			defaultRetentionDays: null,
			exportable: false,
			excludedReason:
				'Operational replay ledger of mutating tools and workflow actions; the catalog items it points at are exported by catalog.core.items.',
		},
	];
}
