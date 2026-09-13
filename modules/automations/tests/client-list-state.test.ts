import { describe, expect, it } from 'vitest';
import {
	AUTOMATION_LIST_PAGE_SIZE,
	FIRST_PAGE,
	listRequest,
	listSort,
	movePage,
	pageLoaded,
} from '../src/client/state.ts';

describe('automations client list state', () => {
	it('opens the next page with the cursor the page on screen handed back', () => {
		const loaded = pageLoaded(FIRST_PAGE, 'cursor-1');
		const second = movePage(loaded, 1);
		expect(second).toEqual({
			pageIndex: 1,
			cursors: [null, 'cursor-1'],
			nextCursor: null,
		});
		const third = movePage(pageLoaded(second, 'cursor-2'), 2);
		expect(third.cursors).toEqual([null, 'cursor-1', 'cursor-2']);
		expect(
			listRequest({ sorting: [], query: '', enabledOnly: false, paging: third })
				.cursor,
		).toBe('cursor-2');
	});

	it('goes back through the cursors it already holds and never past the end', () => {
		const third = movePage(
			pageLoaded(movePage(pageLoaded(FIRST_PAGE, 'c1'), 1), 'c2'),
			2,
		);
		const back = movePage(third, 1);
		expect(back.pageIndex).toBe(1);
		expect(back.cursors).toEqual([null, 'c1', 'c2']);
		expect(
			listRequest({ sorting: [], query: '', enabledOnly: false, paging: back })
				.cursor,
		).toBe('c1');
		expect(movePage(back, 0).pageIndex).toBe(0);
		expect(movePage(back, -1)).toBe(back);
		/* Without a next cursor there is no page 4 to open. */
		expect(movePage(third, 3)).toBe(third);
		expect(movePage(third, 5)).toBe(third);
		expect(movePage(pageLoaded(third, null), 3)).toEqual(
			pageLoaded(third, null),
		);
	});

	it('restarts from the first page when a filter or sort changes', () => {
		const deep = movePage(pageLoaded(FIRST_PAGE, 'c1'), 1);
		expect(deep.pageIndex).toBe(1);
		expect(FIRST_PAGE).toEqual({
			pageIndex: 0,
			cursors: [null],
			nextCursor: null,
		});
		const request = listRequest({
			sorting: [{ key: 'updatedAt', desc: true }],
			query: '  digest ',
			enabledOnly: true,
			paging: FIRST_PAGE,
		});
		expect(request).toEqual({
			sort: 'updatedAt',
			direction: 'desc',
			query: '  digest ',
			enabledOnly: true,
			limit: AUTOMATION_LIST_PAGE_SIZE,
			cursor: null,
		});
	});

	it('maps only the server sort keys and falls back to the label order', () => {
		expect(listSort([])).toEqual({ sort: 'label', direction: 'asc' });
		expect(listSort([{ key: 'label', desc: true }])).toEqual({
			sort: 'label',
			direction: 'desc',
		});
		expect(listSort([{ key: 'target', desc: true }])).toEqual({
			sort: 'label',
			direction: 'asc',
		});
	});
});
