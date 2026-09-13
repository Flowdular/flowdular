import { describe, expect, it } from 'vitest';
import {
	bulkOutcomeCounts,
	bulkTargets,
	DEFAULT_MEMBER_SORTING,
	loadedListing,
	memberSort,
	pageCursor,
	rememberNextCursor,
	replaceMember,
	resetPageCursors,
	searchPending,
} from '../src/client/state.ts';
import type { TenantMember } from '@flowdular/module-auth';

/* The screen keeps one cursor per page it has opened; these are the moves the
   pager and the filters make on that stack. */
describe('member page cursors', () => {
	it('opens the next page on the cursor the current one answered', () => {
		let cursors = resetPageCursors();
		expect(pageCursor(cursors, 0)).toBeNull();
		expect(pageCursor(cursors, 1)).toBeUndefined();

		cursors = rememberNextCursor(cursors, 0, 'c1');
		expect(pageCursor(cursors, 1)).toBe('c1');
		cursors = rememberNextCursor(cursors, 1, 'c2');
		expect(pageCursor(cursors, 2)).toBe('c2');
		expect(pageCursor(cursors, 3)).toBeUndefined();
	});

	it('goes back on the stored cursor and forward again without a new answer', () => {
		const cursors = rememberNextCursor(
			rememberNextCursor(resetPageCursors(), 0, 'c1'),
			1,
			'c2',
		);
		expect(pageCursor(cursors, 0)).toBeNull();
		expect(pageCursor(cursors, 1)).toBe('c1');
		expect(pageCursor(cursors, 2)).toBe('c2');
	});

	it('drops the pages after a page that answered no cursor', () => {
		const cursors = rememberNextCursor(
			rememberNextCursor(resetPageCursors(), 0, 'c1'),
			1,
			'c2',
		);
		const shorter = rememberNextCursor(cursors, 0, null);
		expect(shorter).toEqual([null]);
		const rewritten = rememberNextCursor(cursors, 0, 'c1b');
		expect(rewritten).toEqual([null, 'c1b']);
	});

	it('resets to the first page when a filter, a sort or a page size changes', () => {
		expect(resetPageCursors()).toEqual([null]);
		expect(searchPending('ada ', 'ada')).toBe(false);
		expect(searchPending('adam', 'ada')).toBe(true);
	});
});

describe('member sort', () => {
	it('names the server key and direction behind the table sorting', () => {
		expect(memberSort(DEFAULT_MEMBER_SORTING)).toEqual({
			sort: 'displayName',
			direction: 'asc',
		});
		expect(memberSort([{ key: 'email', desc: true }])).toEqual({
			sort: 'email',
			direction: 'desc',
		});
		/* A cleared sort is the default order, never an unknown key. */
		expect(memberSort([])).toEqual({ sort: 'displayName', direction: 'asc' });
		expect(memberSort([{ key: 'role', desc: false }])).toEqual({
			sort: 'displayName',
			direction: 'asc',
		});
	});
});

const member = (accountId: string, displayName: string): TenantMember => ({
	accountId,
	email: `${accountId}@example.com`,
	displayName,
	role: 'member',
	roleId: null,
	status: 'active',
	membershipStatus: 'active',
	scopes: [],
	passwordChangeRequired: false,
	createdAt: 1,
});

describe('selection', () => {
	const listing = {
		pageIndex: 1,
		pageSize: 2,
		sorting: DEFAULT_MEMBER_SORTING,
		query: 'a',
		status: '' as const,
		cursors: [null, 'c1'] as const,
	};

	it('is emptied by every loaded listing, whether a page, a sort, a filter or a refresh', () => {
		const loaded = loadedListing(listing, {
			items: [member('a', 'Ada'), member('b', 'Bea')],
			page: { nextCursor: 'c2', limit: 2 },
		});
		expect(loaded.selectedIds.size).toBe(0);
		expect(loaded.users.map((user) => user.accountId)).toEqual(['a', 'b']);
		expect(loaded.cursors).toEqual([null, 'c1', 'c2']);
		expect(loaded.pageIndex).toBe(1);
		expect(loaded.appliedQuery).toBe('a');
	});

	it('names the selected rows on screen except the acting principal, and survives an in-place patch', () => {
		const page = [member('me', 'Me'), member('a', 'Ada'), member('b', 'Bea')];
		const selected = new Set(['me', 'a', 'gone']);
		expect(bulkTargets(page, selected, 'me')).toEqual(['a']);
		const patched = replaceMember(page, {
			...member('a', 'Ada'),
			membershipStatus: 'disabled',
		});
		expect(bulkTargets(patched, selected, 'me')).toEqual(['a']);
		expect(bulkTargets(page, new Set(), 'me')).toEqual([]);
	});

	it('counts the outcomes for the toast', () => {
		expect(
			bulkOutcomeCounts([
				{ accountId: 'a', outcome: 'updated' },
				{ accountId: 'b', outcome: 'not-found' },
				{ accountId: 'c', outcome: 'refused', reason: 'SELF_TARGET' },
				{ accountId: 'd', outcome: 'updated' },
			]),
		).toEqual({ updated: 2, missing: 1, refused: 1 });
		expect(bulkOutcomeCounts([])).toEqual({
			updated: 0,
			missing: 0,
			refused: 0,
		});
	});
});

describe('replaceMember', () => {
	it('keeps the server order and patches the row in place', () => {
		const page = [member('b', 'Bea'), member('a', 'Ada')];
		const patched = replaceMember(page, member('a', 'Adam'));
		expect(patched.map((user) => user.displayName)).toEqual(['Bea', 'Adam']);
		expect(replaceMember(page, member('z', 'Zed'))).toEqual(page);
	});
});
