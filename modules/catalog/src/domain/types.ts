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
