export type CatalogItemKind = 'product' | 'service';

export interface CatalogItem {
	readonly id: string;
	readonly tenantId: string;
	readonly sku: string;
	readonly name: string;
	readonly kind: CatalogItemKind;
	readonly unit: string;
	readonly basePriceMinor: number;
	readonly currency: string;
	readonly status: 'active' | 'archived';
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type CatalogItemStatus = CatalogItem['status'];

/** The orders the items list answers; each one ends in the item id. */
export const CATALOG_LIST_SORTS = ['name', 'sku', 'updatedAt'] as const;
export type CatalogListSort = (typeof CATALOG_LIST_SORTS)[number];

/** Characters a list search term may carry. */
export const CATALOG_SEARCH_LENGTH = 120;

/** Ids one bulk lifecycle call may name. */
export const CATALOG_BULK_LIMIT = 100;

export interface CatalogBulkOutcome {
	readonly id: string;
	readonly outcome: 'updated' | 'not-found' | 'refused';
	/** The stable service code behind a refusal. */
	readonly reason?: string;
}

export interface CreateCatalogItemInput {
	readonly sku: string;
	readonly name: string;
	readonly kind: CatalogItemKind;
	readonly unit: string;
	readonly basePriceMinor: number;
	readonly currency: string;
}

export interface UpdateCatalogItemInput {
	readonly id: string;
	readonly name: string;
	readonly kind: CatalogItemKind;
	readonly unit: string;
	readonly basePriceMinor: number;
	readonly currency: string;
}
