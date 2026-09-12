import { describe, expect, it } from 'vitest';
import {
	INBOX_STATUSES,
	type NotificationsInbox,
	type NotificationsInboxStatus,
} from '../src/domain/types.ts';
import {
	inboxListing,
	inboxRowActions,
	selectedInboxItem,
} from '../src/client/inbox.ts';

function item(
	id: string,
	status: NotificationsInboxStatus,
): NotificationsInbox {
	return {
		id,
		tenantId: 'tenant-1',
		recipientAccountId: 'account-1',
		kind: 'agent-run-failed',
		title: 'Nightly invoice extraction failed',
		body: null,
		sourceModule: 'agents.core',
		sourceRef: 'run_' + id,
		status,
		readAt: status === 'unread' ? null : '2026-09-11T08:42:00.000Z',
		createdAt: 1_757_000_000_000,
	};
}

describe('inbox listing', () => {
	it('hides archived items while no status is chosen', () => {
		const items = [item('a', 'unread'), item('b', 'archived')];
		const listing = inboxListing(items, '', '');
		expect(listing.visible.map((entry) => entry.id)).toEqual(['a']);
	});

	it('shows every loaded item once a status is chosen', () => {
		const items = [item('a', 'unread'), item('b', 'archived')];
		expect(inboxListing(items, 'archived', '').visible).toEqual(items);
	});

	/* The table picks its empty copy from `filtered`. An inbox whose items are
	   all archived is narrowed by the default rule, not a first run, so the copy
	   has to say that the filter is hiding them. */
	it('reads an all-archived inbox as narrowed, not as a first run', () => {
		const listing = inboxListing([item('b', 'archived')], '', '');
		expect([
			listing.visible.length,
			listing.filtered,
			listing.activeFilters,
		]).toEqual([0, true, 0]);
	});

	it('reads an empty inbox as a first run', () => {
		expect(inboxListing([], '', '')).toEqual({
			visible: [],
			filtered: false,
			activeFilters: 0,
		});
	});

	it('counts only the filters the reader chose', () => {
		const items = [item('a', 'unread')];
		expect(inboxListing(items, '', '').activeFilters).toBe(0);
		expect(inboxListing(items, 'unread', '').activeFilters).toBe(1);
		expect(inboxListing(items, '', 'agent-run-failed').activeFilters).toBe(1);
		expect(
			inboxListing(items, 'unread', 'agent-run-failed').activeFilters,
		).toBe(2);
	});

	it('reports a kind filter that matches nothing as narrowed', () => {
		expect(inboxListing([], '', 'agent-run-failed').filtered).toBe(true);
	});
});

describe('inbox selection', () => {
	/* Archiving the open record drops it out of the default list. The drawer
	   reads the loaded set, so it survives the change it just made. */
	it('keeps resolving a record the default list no longer shows', () => {
		const items = [item('a', 'archived'), item('b', 'unread')];
		expect(
			inboxListing(items, '', '').visible.map((entry) => entry.id),
		).toEqual(['b']);
		expect(selectedInboxItem(items, 'a')?.id).toBe('a');
	});

	it('resolves to nothing without a selection or after a reload drops it', () => {
		const items = [item('b', 'unread')];
		expect(selectedInboxItem(items, null)).toBeNull();
		expect(selectedInboxItem(items, 'gone')).toBeNull();
		expect(selectedInboxItem([], 'b')).toBeNull();
	});
});

describe('inbox row actions', () => {
	it('offers opening the record on every row, whatever the member may change', () => {
		for (const status of INBOX_STATUSES) {
			expect([status, inboxRowActions(status, false)]).toEqual([
				status,
				['open'],
			]);
			expect([status, inboxRowActions(status, true)[0]]).toEqual([
				status,
				'open',
			]);
		}
	});

	it('adds the change that moves the item out of the list being read', () => {
		expect(inboxRowActions('unread', true)).toEqual(['open', 'archive']);
		expect(inboxRowActions('read', true)).toEqual(['open', 'archive']);
		expect(inboxRowActions('archived', true)).toEqual(['open', 'mark-unread']);
	});

	/* Two compact buttons are what the row can hold beside its columns; a third
	   overruns the action column in the longer locale. */
	it('never offers more than two actions', () => {
		for (const status of INBOX_STATUSES) {
			for (const canManage of [false, true]) {
				expect([
					status,
					canManage,
					inboxRowActions(status, canManage).length,
				]).toEqual([status, canManage, canManage ? 2 : 1]);
			}
		}
	});
});
