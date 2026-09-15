import { randomBytes } from 'node:crypto';
import {
	defineListExport,
	type DefinedListExport,
} from '@flowdular/sdk/server';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import { CATALOG_ITEMS_EXPORT_LIST_ID } from '../domain/lists.ts';
import type { CatalogItem } from '../domain/types.ts';
import type { CatalogRuntime } from '../server/runtime.ts';
import {
	decodeListCursor,
	encodeListCursor,
	type CatalogListQuery,
} from '../api/list-cursor.ts';

/* The export walks the whole workspace in SKU order, the keyset the unique
   (tenant_id, sku_normalized) index already carries, without a filter. */
const EXPORT_QUERY: CatalogListQuery = {
	sort: 'sku',
	direction: 'asc',
	kind: null,
	status: null,
	search: '',
};

/**
 * The workspace's catalog items as a CSV export. Every page is the same read
 * the items list endpoint answers, under the tenant of the principal the job
 * was started by and behind the permission the Catalog screen itself needs.
 */
export function createCatalogItemsListExport(
	runtime: CatalogRuntime,
): DefinedListExport {
	const cursorSecret = randomBytes(32);
	return defineListExport<CatalogItem>({
		id: CATALOG_ITEMS_EXPORT_LIST_ID,
		label: 'Catalog items',
		permission: CATALOG_PERMISSIONS.read,
		columns: [
			{ key: 'sku', header: 'SKU', value: (row) => row.sku },
			{ key: 'name', header: 'Name', value: (row) => row.name },
			{ key: 'kind', header: 'Kind', value: (row) => row.kind },
			{ key: 'unit', header: 'Unit', value: (row) => row.unit },
			{
				key: 'basePriceMinor',
				header: 'Base price (minor units)',
				value: (row) => row.basePriceMinor,
			},
			{ key: 'currency', header: 'Currency', value: (row) => row.currency },
			{ key: 'status', header: 'Status', value: (row) => row.status },
		],
		page: async (principal, cursor, limit) => {
			const page = await (
				await runtime.service()
			).listPage(principal.tenantId, {
				...EXPORT_QUERY,
				limit,
				after:
					cursor === null
						? null
						: decodeListCursor(
								cursorSecret,
								cursor,
								principal.tenantId,
								EXPORT_QUERY,
							),
			});
			return {
				rows: page.items,
				nextCursor: page.next
					? encodeListCursor(
							cursorSecret,
							principal.tenantId,
							EXPORT_QUERY,
							page.next,
						)
					: null,
			};
		},
	});
}
