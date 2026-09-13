import { describe, expect, it } from 'vitest';
import {
	createLoadSequence,
	createScimTokensClientState,
	FIRST_PAGE,
	hasNextPage,
	pageCursor,
	pageLoaded,
	sortingState,
	sortOf,
	turnTo,
} from '../src/client/state.ts';

describe('DIRECTORY-SCREEN-PAGING cursor stack', () => {
	it('opens page 0 without a cursor and reaches the next page through the answered one', () => {
		expect(pageCursor(FIRST_PAGE)).toBeNull();
		expect(hasNextPage(FIRST_PAGE)).toBe(false);
		const first = pageLoaded(FIRST_PAGE, 'c1');
		expect(hasNextPage(first)).toBe(true);
		const second = turnTo(first, 1);
		expect(second.pageIndex).toBe(1);
		expect(pageCursor(second)).toBe('c1');
		expect(hasNextPage(second)).toBe(false);
		const loaded = pageLoaded(second, 'c2');
		expect(pageCursor(turnTo(loaded, 2))).toBe('c2');
	});

	it('goes back through the stored cursor and refuses a page it never reached', () => {
		const third = pageLoaded(
			turnTo(pageLoaded(turnTo(pageLoaded(FIRST_PAGE, 'c1'), 1), 'c2'), 2),
			null,
		);
		expect(third.pageIndex).toBe(2);
		expect(hasNextPage(third)).toBe(false);
		const back = turnTo(third, 1);
		expect(pageCursor(back)).toBe('c1');
		expect(pageCursor(turnTo(back, 0))).toBeNull();
		/* Page 3 was never answered, page 2 is on screen and negative is nothing. */
		expect(turnTo(third, 3)).toBe(third);
		expect(turnTo(third, 2)).toBe(third);
		expect(turnTo(third, -1)).toBe(third);
	});

	/* A page reloaded in place answers a fresh cursor; the pages behind the old
	   one were cut from a position that no longer stands. */
	it('forgets the pages behind a reloaded one and resets to the first page on a new listing', () => {
		const walked = turnTo(
			pageLoaded(turnTo(pageLoaded(FIRST_PAGE, 'c1'), 1), 'c2'),
			1,
		);
		expect(walked.cursors).toEqual([null, 'c1', 'c2']);
		const reloaded = pageLoaded(walked, 'c2b');
		expect(reloaded.cursors).toEqual([null, 'c1', 'c2b']);
		expect(pageLoaded(walked, null).cursors).toEqual([null, 'c1']);
		expect(FIRST_PAGE).toEqual({ pageIndex: 0, cursors: [null] });
	});
});

describe('directory load sequence', () => {
	/* A page turn or a search still in flight when a filter changes answers
	   after the filter's own load; whichever lands last must not win. */
	it('lets only the load fired last write, whatever order the responses land in', () => {
		const loads = createLoadSequence();
		const first = loads.begin();
		expect(loads.isLatest(first)).toBe(true);
		const second = loads.begin();
		expect(loads.isLatest(first)).toBe(false);
		expect(loads.isLatest(second)).toBe(true);
		const third = loads.begin();
		expect([first, second, third].map(loads.isLatest)).toEqual([
			false,
			false,
			true,
		]);
		expect(loads.isLatest(0)).toBe(false);
	});

	it('gives each screen a sequence of its own', () => {
		const tokens = createScimTokensClientState();
		const ticket = tokens.loads.begin();
		expect(tokens.loads.isLatest(ticket)).toBe(true);
		expect(createScimTokensClientState().loads.isLatest(ticket)).toBe(false);
	});
});

describe('directory list sort', () => {
	it('maps the table report to the request and falls back to the default order', () => {
		expect(sortOf([{ key: 'label', desc: true }], ['label'], 'label')).toEqual({
			sort: 'label',
			direction: 'desc',
		});
		expect(
			sortOf(
				[{ key: 'displayName', desc: false }],
				['precedence', 'displayName'],
				'precedence',
			),
		).toEqual({ sort: 'displayName', direction: 'asc' });
		expect(sortOf([], ['label'], 'label')).toEqual({
			sort: 'label',
			direction: 'asc',
		});
		expect(
			sortOf(
				[{ key: 'memberCount', desc: true }],
				['precedence'],
				'precedence',
			),
		).toEqual({
			sort: 'precedence',
			direction: 'asc',
		});
		expect(sortingState({ sort: 'label', direction: 'desc' })).toEqual([
			{ key: 'label', desc: true },
		]);
	});
});
