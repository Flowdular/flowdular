import type { Actor, HistoryPage, HistoryQuery } from '@flowdular/sdk/kernel';
import type { CatalogItem } from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

export class DuplicateSkuError extends Error {
	constructor() {
		super('An item with this SKU already exists in the active tenant.');
		this.name = 'DuplicateSkuError';
	}
}

/** The database-agnostic business port. No driver type crosses it. */
export interface CatalogRepository {
	list(tenantId: string): Promise<readonly CatalogItem[]>;
	find(tenantId: string, id: string): Promise<CatalogItem | null>;
	create(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
	): Promise<CatalogItem>;
	createIdempotent(
		item: CatalogItem,
		normalizedSku: string,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<CatalogItem>;
	update(item: CatalogItem, actor: Actor): Promise<CatalogItem | null>;
	setStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): Promise<CatalogItem | null>;
	delete(tenantId: string, id: string, actor: Actor): Promise<boolean>;
	history(query: HistoryQuery): Promise<HistoryPage>;
}
