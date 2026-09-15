import { cell, createStore } from 'segment-state';
import type { HistoryEntry } from '@flowdular/sdk/kernel';
import type { TableSort } from '@flowdular/sdk/ui';
import type {
	CatalogBulkOutcome,
	CatalogItem,
	CatalogItemKind,
	CatalogItemStatus,
	CatalogListSort,
} from '../domain/types.ts';
import type { CatalogListPage } from './api.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type CatalogStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export type CatalogKindFilter = '' | CatalogItemKind;
export type CatalogStatusFilter = '' | CatalogItemStatus;

export const DEFAULT_CATALOG_SORTING: readonly TableSort[] = [
	{ key: 'name', desc: false },
];

/** The screen opens on the active items; archived ones are a filter away. */
export const DEFAULT_STATUS_FILTER: CatalogStatusFilter = 'active';

/**
 * The cursor that opened each page the reader has visited: page 0 has none,
 * and page n holds the cursor page n - 1 answered. Going back reuses the stored
 * cursor; a page past the stack cannot be opened.
 */
export type PageCursors = readonly (string | null)[];

/** One listing as the server answers it: the page, its order and its filters. */
export interface Listing {
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly sorting: readonly TableSort[];
	readonly query: string;
	readonly kind: CatalogKindFilter;
	readonly status: CatalogStatusFilter;
	readonly cursors: PageCursors;
}

export function createCatalogClientState() {
	const store = createStore({
		items: cell<readonly CatalogItem[]>([]),
		query: '',
		/** The term the rows on screen answer; typing moves `query` ahead of it. */
		appliedQuery: '',
		kindFilter: cell<CatalogKindFilter>(''),
		statusFilter: cell<CatalogStatusFilter>(DEFAULT_STATUS_FILTER),
		sorting: cell<readonly TableSort[]>(DEFAULT_CATALOG_SORTING),
		pageIndex: 0,
		pageSize: 50,
		cursors: cell<PageCursors>([null]),
		nextCursor: cell<string | null>(null),
		filtersOpen: false,
		formOpen: false,
		deleteConfirmOpen: false,
		editingItem: cell<CatalogItem | null>(null),
		historyOpen: false,
		historyItem: cell<CatalogItem | null>(null),
		historyEntries: cell<readonly HistoryEntry[]>([]),
		historyLoading: false,
		historyError: '',
		status: cell<CatalogStatus>('idle'),
		error: '',
		formSession: 0,
		/* Row ids checked in the table; the screen owns it, the table never
		   clears it. */
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		confirmArchiveMany: false,
		exportStarted: false,
	});
	return { store, state: store.state };
}

/** The server's sort key and direction behind the table's sorting state. */
export function catalogSort(sorts: readonly TableSort[]): {
	readonly sort: CatalogListSort;
	readonly direction: 'asc' | 'desc';
} {
	const first = sorts[0] ?? DEFAULT_CATALOG_SORTING[0]!;
	return {
		sort: first.key === 'sku' || first.key === 'updatedAt' ? first.key : 'name',
		direction: first.desc ? 'desc' : 'asc',
	};
}

/** The cursor that opens `pageIndex`, or undefined when the reader never reached it. */
export function pageCursor(
	cursors: PageCursors,
	pageIndex: number,
): string | null | undefined {
	return pageIndex < cursors.length ? cursors[pageIndex] : undefined;
}

/**
 * Records what the page at `pageIndex` answered: the cursor of the page after
 * it, or nothing when it was the last. Pages beyond the next one are dropped,
 * since the set may have changed under them.
 */
export function rememberNextCursor(
	cursors: PageCursors,
	pageIndex: number,
	nextCursor: string | null,
): PageCursors {
	const kept = cursors.slice(0, pageIndex + 1);
	return nextCursor === null ? kept : [...kept, nextCursor];
}

export function resetPageCursors(): PageCursors {
	return [null];
}

/**
 * What a loaded page writes to the screen. The selection is emptied with every
 * listing, on a page, sort or filter change as much as on a refresh, because a
 * selected id names a row the reader saw on the page that is being replaced.
 */
export function loadedListing(
	next: Listing,
	page: CatalogListPage,
): {
	readonly items: readonly CatalogItem[];
	readonly appliedQuery: string;
	readonly pageIndex: number;
	readonly cursors: PageCursors;
	readonly nextCursor: string | null;
	readonly selectedIds: ReadonlySet<string>;
} {
	return {
		items: page.items,
		appliedQuery: next.query,
		pageIndex: next.pageIndex,
		cursors: rememberNextCursor(
			next.cursors,
			next.pageIndex,
			page.page.nextCursor,
		),
		nextCursor: page.page.nextCursor,
		selectedIds: new Set(),
	};
}

export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}

/** The selected rows a lifecycle action may name: on screen and in the status it leaves. */
export function bulkTargets(
	items: readonly CatalogItem[],
	selected: ReadonlySet<string>,
	from: CatalogItemStatus,
): readonly string[] {
	return items
		.filter((item) => selected.has(item.id) && item.status === from)
		.map((item) => item.id);
}

/** How many ids each outcome covered, for the toast after a bulk action. */
export function bulkOutcomeCounts(outcomes: readonly CatalogBulkOutcome[]): {
	readonly updated: number;
	readonly missing: number;
	readonly refused: number;
} {
	let updated = 0;
	let missing = 0;
	let refused = 0;
	for (const entry of outcomes) {
		if (entry.outcome === 'updated') updated += 1;
		else if (entry.outcome === 'not-found') missing += 1;
		else refused += 1;
	}
	return { updated, missing, refused };
}

/* The server ordered the page, so a changed row keeps its place until the next
   read; a row that is not on this page changes nothing here. */
export function replaceItem(
	items: readonly CatalogItem[],
	item: CatalogItem,
): readonly CatalogItem[] {
	return items.map((current) => (current.id === item.id ? item : current));
}
