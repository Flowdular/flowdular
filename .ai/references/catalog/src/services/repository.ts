import type {
	Actor,
	HistoryEntry,
	HistoryPage,
	HistoryQuery,
} from '@flowdular/sdk/kernel';
import type {
	CatalogItem,
	CatalogItemKind,
	CatalogItemStatus,
	CatalogListSort,
} from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

export class DuplicateSkuError extends Error {
	constructor() {
		super('An item with this SKU already exists in the active tenant.');
		this.name = 'DuplicateSkuError';
	}
}

/** Keyset position of an export page: the record time and id of its last row. */
export interface ExportCursor {
	readonly at: number;
	readonly id: string;
}

/** Keyset position of a list page: the projected sort value and id of its last row. */
export interface CatalogPageKeyset {
	readonly sortValue: string;
	readonly id: string;
}

/** One list page read, already validated by the service. */
export interface CatalogListRead {
	readonly sort: CatalogListSort;
	readonly direction: 'asc' | 'desc';
	readonly kind: CatalogItemKind | null;
	readonly status: CatalogItemStatus | null;
	/** Lower-cased substring of the name or the SKU; null narrows nothing. */
	readonly term: string | null;
	readonly limit: number;
	readonly after: CatalogPageKeyset | null;
}

export interface CatalogListPage {
	readonly items: readonly CatalogItem[];
	/** The keyset after the last row, only when the page was full. */
	readonly next: CatalogPageKeyset | null;
}

/** The database-agnostic business port. No driver type crosses it. */
export interface CatalogRepository {
	listPage(tenantId: string, read: CatalogListRead): Promise<CatalogListPage>;
	listItemsForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly CatalogItem[]>;
	listHistoryForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly HistoryEntry[]>;
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
