import { describe, expect, it } from 'vitest';
import { translationKeys } from '@flowdular/contracts';
import type { ApprovalRequest } from '../src/domain/types.ts';
import {
	approvalsListing,
	canOpenPage,
	decidableIds,
	decideOutcomeCounts,
	FIRST_PAGE,
	pageCursor,
	recordNextCursor,
} from '../src/client/state.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

const request = {
	id: 'request-1',
	tenantId: 'tenant-a',
	subjectModule: 'catalog.core',
	subjectRef: 'product-4711',
	permission: 'catalog.products.manage',
	action: 'publish',
	title: 'Publish product 4711',
	summary: null,
	requesterAccountId: 'account-requester',
	requirement: {
		roleKey: 'owner',
		scope: null,
		decisions: 1,
		expiresInDays: 7,
	},
	decisionsNeeded: 1,
	status: 'pending',
	expiresAt: 2_000,
	resolvedAt: null,
	createdAt: 1_000,
} satisfies ApprovalRequest;

describe('approvals inbox screen state', () => {
	it('reports the error state after a failed load instead of an empty inbox', () => {
		expect(approvalsListing([], 'decidable', '', 'error').screen).toBe('error');
		/* The rows a failed refresh left behind answer for the scope that was
		   asked for before it, so they are not what the member is shown. */
		expect(approvalsListing([request], 'mine', '', 'error').screen).toBe(
			'error',
		);
	});

	it('reports the denied state a 403 leaves and the table for every other state', () => {
		expect(approvalsListing([], 'decidable', '', 'denied').screen).toBe(
			'denied',
		);
		for (const status of ['idle', 'loading', 'submitting'] as const) {
			expect([
				status,
				approvalsListing([], 'decidable', '', status).screen,
			]).toEqual([status, 'table']);
		}
	});

	it('keeps reporting what the table says about an empty result', () => {
		expect(approvalsListing([request], 'decidable', '')).toMatchObject({
			visible: [request],
			filtered: false,
			activeFilters: 0,
		});
		expect(approvalsListing([], 'all', 'pending')).toMatchObject({
			filtered: true,
			activeFilters: 2,
		});
	});

	it('ships the error state copy in every locale', () => {
		for (const bundle of [translationsEn, translationsPl]) {
			const keys = translationKeys(bundle);
			for (const key of ['inbox.error.title', 'inbox.error.hint']) {
				expect([key, keys.includes(key)]).toEqual([key, true]);
			}
		}
	});
});

describe('APPROVALS-INBOX-PAGE cursor stack', () => {
	it('opens the next page on the cursor the previous one answered', () => {
		expect(pageCursor(FIRST_PAGE, 0)).toBeNull();
		expect(canOpenPage(FIRST_PAGE, 1)).toBe(false);
		const afterFirst = recordNextCursor(FIRST_PAGE, 0, 'c1');
		expect(canOpenPage(afterFirst, 1)).toBe(true);
		expect(pageCursor(afterFirst, 1)).toBe('c1');
		const afterSecond = recordNextCursor(afterFirst, 1, 'c2');
		expect(afterSecond).toEqual([null, 'c1', 'c2']);
		expect(canOpenPage(afterSecond, 3)).toBe(false);
	});

	it('goes back on the stored cursor and forgets the pages past a reloaded one', () => {
		const walked = recordNextCursor(
			recordNextCursor(FIRST_PAGE, 0, 'c1'),
			1,
			'c2',
		);
		expect(pageCursor(walked, 0)).toBeNull();
		expect(pageCursor(walked, 1)).toBe('c1');
		/* Page 1 reloaded and turned out to be the last one. */
		expect(recordNextCursor(walked, 1, null)).toEqual([null, 'c1']);
		expect(recordNextCursor(walked, 0, 'c9')).toEqual([null, 'c9']);
	});

	it('starts over from the first page when a filter changes', () => {
		const walked = recordNextCursor(FIRST_PAGE, 0, 'c1');
		expect(walked).not.toBe(FIRST_PAGE);
		expect(FIRST_PAGE).toEqual([null]);
		expect(canOpenPage(FIRST_PAGE, 0)).toBe(true);
		expect(canOpenPage(FIRST_PAGE, -1)).toBe(false);
	});
});

describe('APPROVALS-DECIDE-MANY selection', () => {
	it('offers the bulk decision only the pending rows that are selected and on screen', () => {
		const rows = [
			request,
			{ ...request, id: 'request-2', status: 'approved' as const },
			{ ...request, id: 'request-3' },
		];
		expect(
			decidableIds(
				rows,
				new Set(['request-1', 'request-2', 'request-3', 'gone']),
			),
		).toEqual(['request-1', 'request-3']);
		expect(decidableIds(rows, new Set())).toEqual([]);
	});

	it('counts every outcome for the notice', () => {
		expect(
			decideOutcomeCounts([
				{ id: 'a', outcome: 'decided' },
				{ id: 'b', outcome: 'not-found' },
				{ id: 'c', outcome: 'refused', reason: 'APPROVAL_NOT_PENDING' },
				{ id: 'd', outcome: 'decided' },
			]),
		).toEqual({ decided: 2, missing: 1, refused: 1 });
		expect(decideOutcomeCounts([])).toEqual({
			decided: 0,
			missing: 0,
			refused: 0,
		});
	});

	it('ships the bulk decision copy in every locale', () => {
		for (const bundle of [translationsEn, translationsPl]) {
			const keys = translationKeys(bundle);
			for (const key of [
				'selection.label',
				'action.approveSelected',
				'action.rejectSelected',
				'decideMany.description',
				'notice.decidedMany',
				'error.decideMany',
			]) {
				expect([key, keys.includes(key)]).toEqual([key, true]);
			}
		}
	});
});
