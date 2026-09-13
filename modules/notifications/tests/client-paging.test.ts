import { describe, expect, it } from 'vitest';
import type {
	DeliveryAttempt,
	NotificationsInbox,
	WebhookSubscription,
} from '../src/domain/types.ts';
import {
	FIRST_PAGE,
	pageCursor,
	pageLoaded,
	searchPending,
	subscriptionOptions,
	transitionableIds,
	transitionOutcomeCounts,
} from '../src/client/state.ts';

describe('cursor stack', () => {
	it('opens the first page without a cursor and knows no page past it', () => {
		expect(pageCursor(FIRST_PAGE, 0)).toBe('');
		expect(pageCursor(FIRST_PAGE, 1)).toBeNull();
		expect(FIRST_PAGE.hasMore).toBe(false);
	});

	it('records the cursor of the page after each one loaded, forward', () => {
		const one = pageLoaded(FIRST_PAGE, 0, 'c-1');
		expect([pageCursor(one, 1), one.hasMore]).toEqual(['c-1', true]);
		expect(pageCursor(one, 2)).toBeNull();

		const two = pageLoaded(one, 1, 'c-2');
		expect(two.cursors).toEqual(['', 'c-1', 'c-2']);
		expect(pageCursor(two, 2)).toBe('c-2');
	});

	it('reuses the stored cursor going back and forgets the pages past it', () => {
		const three = pageLoaded(
			pageLoaded(pageLoaded(FIRST_PAGE, 0, 'c-1'), 1, 'c-2'),
			2,
			null,
		);
		expect([three.cursors, three.hasMore]).toEqual([['', 'c-1', 'c-2'], false]);

		/* Back to page 1: its cursor is still there, and what it now says about
		   page 2 replaces what the older walk recorded. */
		expect(pageCursor(three, 1)).toBe('c-1');
		const back = pageLoaded(three, 1, 'c-2b');
		expect([back.cursors, back.hasMore]).toEqual([['', 'c-1', 'c-2b'], true]);
		const short = pageLoaded(three, 1, null);
		expect([short.cursors, short.hasMore]).toEqual([['', 'c-1'], false]);
	});

	it('starts over from the first page when a filter or sort changes', () => {
		const walked = pageLoaded(pageLoaded(FIRST_PAGE, 0, 'c-1'), 1, 'c-2');
		/* The screen restarts with FIRST_PAGE: nothing from the old walk survives. */
		const restarted = pageLoaded(FIRST_PAGE, 0, 'd-1');
		expect(walked.cursors).not.toEqual(restarted.cursors);
		expect(restarted.cursors).toEqual(['', 'd-1']);
	});
});

describe('bulk transition rows', () => {
	const item = (id: string, status: NotificationsInbox['status']) =>
		({ id, status }) as NotificationsInbox;
	const items = [
		item('u', 'unread'),
		item('r', 'read'),
		item('a', 'archived'),
		item('u2', 'unread'),
	];

	it('offers mark-read to the unread rows checked and archive to the open ones', () => {
		const selected = new Set(['u', 'r', 'a', 'other']);
		expect(transitionableIds(items, selected, 'mark-read')).toEqual(['u']);
		expect(transitionableIds(items, selected, 'archive')).toEqual(['u', 'r']);
	});

	it('names nothing when no checked row qualifies', () => {
		expect(transitionableIds(items, new Set(['a']), 'mark-read')).toEqual([]);
		expect(transitionableIds(items, new Set(['a']), 'archive')).toEqual([]);
		expect(transitionableIds(items, new Set(['r']), 'mark-read')).toEqual([]);
	});
});

describe('bulk transition notice', () => {
	it('counts every outcome for the notice', () => {
		expect(
			transitionOutcomeCounts([
				{ id: 'a', outcome: 'updated' },
				{ id: 'b', outcome: 'not-found' },
				{ id: 'c', outcome: 'updated' },
				{ id: 'd', outcome: 'refused', reason: 'INVALID_INPUT' },
			]),
		).toEqual({ updated: 2, missing: 1, refused: 1 });
		expect(transitionOutcomeCounts([])).toEqual({
			updated: 0,
			missing: 0,
			refused: 0,
		});
	});
});

describe('search box', () => {
	it('is pending only while the box is ahead of the term the rows answer', () => {
		expect(searchPending('', '')).toBe(false);
		expect(searchPending(' ops ', 'ops')).toBe(false);
		expect(searchPending('ops', '')).toBe(true);
		expect(searchPending('', 'ops')).toBe(true);
	});
});

describe('subscription filter options', () => {
	const subscription = (id: string, name: string): WebhookSubscription =>
		({ id, name }) as WebhookSubscription;
	const delivery = (subscriptionId: string | null): DeliveryAttempt =>
		({ id: 'd-' + String(subscriptionId), subscriptionId }) as DeliveryAttempt;

	it('names every readable subscription and keeps ids the page names without one', () => {
		expect(
			subscriptionOptions(
				[subscription('s-1', 'Billing'), subscription('s-2', 'Ops')],
				[delivery('s-2'), delivery('s-gone'), delivery(null)],
			),
		).toEqual([
			{ value: 's-1', label: 'Billing' },
			{ value: 's-2', label: 'Ops' },
			{ value: 's-gone', label: 's-gone' },
		]);
	});
});
