import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../src/domain/types.ts';
import {
	bulkOutcomeCounts,
	bulkTargets,
	catalogSort,
	loadedListing,
	pageCursor,
	rememberNextCursor,
	resetPageCursors,
	searchPending,
	type Listing,
} from '../src/client/state.ts';

function item(id: string, status: CatalogItem['status']): CatalogItem {
	return {
		id,
		tenantId: 'tenant-a',
		sku: id.toUpperCase(),
		name: 'Item ' + id,
		kind: 'product',
		unit: 'pcs',
		basePriceMinor: 100,
		currency: 'EUR',
		status,
		createdAt: 1,
		updatedAt: 1,
	};
}

function listing(changes: Partial<Listing> = {}): Listing {
	return {
		pageIndex: 0,
		pageSize: 50,
		sorting: [{ key: 'name', desc: false }],
		query: '',
		kind: '',
		status: 'active',
		cursors: resetPageCursors(),
		...changes,
	};
}

describe('catalog client listing state', () => {
	it('walks the cursor stack forward, back, and resets it on a new listing', () => {
		let cursors = resetPageCursors();
		expect(pageCursor(cursors, 0)).toBeNull();
		expect(pageCursor(cursors, 1)).toBeUndefined();

		cursors = rememberNextCursor(cursors, 0, 'c1');
		expect(pageCursor(cursors, 1)).toBe('c1');
		cursors = rememberNextCursor(cursors, 1, 'c2');
		expect(cursors).toEqual([null, 'c1', 'c2']);

		/* Going back reuses the stored cursor and drops what lay beyond. */
		cursors = rememberNextCursor(cursors, 0, 'c1-again');
		expect(cursors).toEqual([null, 'c1-again']);
		expect(pageCursor(cursors, 2)).toBeUndefined();

		/* The last page answers no cursor, so nothing follows it. */
		cursors = rememberNextCursor(cursors, 1, null);
		expect(cursors).toEqual([null, 'c1-again']);

		expect(resetPageCursors()).toEqual([null]);
	});

	it('writes a loaded page with an empty selection', () => {
		const loaded = loadedListing(
			listing({ pageIndex: 1, cursors: [null, 'c1'], query: 'bolt' }),
			{
				items: [item('a', 'active')],
				page: { nextCursor: 'c2', limit: 50 },
			},
		);
		expect(loaded).toEqual({
			items: [item('a', 'active')],
			appliedQuery: 'bolt',
			pageIndex: 1,
			cursors: [null, 'c1', 'c2'],
			nextCursor: 'c2',
			selectedIds: new Set(),
		});
	});

	it('maps the table sort to the server keys', () => {
		expect(catalogSort([])).toEqual({ sort: 'name', direction: 'asc' });
		expect(catalogSort([{ key: 'sku', desc: true }])).toEqual({
			sort: 'sku',
			direction: 'desc',
		});
		expect(catalogSort([{ key: 'updatedAt', desc: false }])).toEqual({
			sort: 'updatedAt',
			direction: 'asc',
		});
		expect(catalogSort([{ key: 'price', desc: false }])).toEqual({
			sort: 'name',
			direction: 'asc',
		});
	});

	it('names only the selected rows in the status the action leaves', () => {
		const items = [
			item('a', 'active'),
			item('b', 'archived'),
			item('c', 'active'),
		];
		const selected = new Set(['a', 'b', 'missing']);
		expect(bulkTargets(items, selected, 'active')).toEqual(['a']);
		expect(bulkTargets(items, selected, 'archived')).toEqual(['b']);
	});

	it('counts bulk outcomes and detects a pending search', () => {
		expect(
			bulkOutcomeCounts([
				{ id: 'a', outcome: 'updated' },
				{ id: 'b', outcome: 'not-found' },
				{ id: 'c', outcome: 'refused', reason: 'X' },
				{ id: 'd', outcome: 'updated' },
			]),
		).toEqual({ updated: 2, missing: 1, refused: 1 });
		expect(searchPending(' bolt ', 'bolt')).toBe(false);
		expect(searchPending('bolt', '')).toBe(true);
	});
});
