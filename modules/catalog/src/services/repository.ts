import type { CatalogItem } from '../domain/types.ts';

export class DuplicateSkuError extends Error {
	constructor() {
		super('An item with this SKU already exists in the active tenant.');
		this.name = 'DuplicateSkuError';
	}
}

export interface CatalogRepository {
	list(tenantId: string): readonly CatalogItem[];
	create(item: CatalogItem, normalizedSku: string): CatalogItem;
}
