import type { Actor, HistoryPage, HistoryQuery } from '@coreloom/kernel';
import type { CatalogItem } from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

export class DuplicateSkuError extends Error {
	constructor() {
		super('An item with this SKU already exists in the active tenant.');
		this.name = 'DuplicateSkuError';
	}
}

export interface CatalogRepository {
	list(tenantId: string): readonly CatalogItem[];
	find(tenantId: string, id: string): CatalogItem | null;
	create(item: CatalogItem, normalizedSku: string, actor: Actor): CatalogItem;
	createIdempotent(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): CatalogItem;
	update(item: CatalogItem, actor: Actor): CatalogItem | null;
	setStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): CatalogItem | null;
	delete(tenantId: string, id: string, actor: Actor): boolean;
	history(query: HistoryQuery): HistoryPage;
}
