import { describe, expect, it } from 'vitest';
import {
	INBOX_STATUSES,
	type NotificationsInbox,
	type NotificationsInboxStatus,
} from '../src/domain/types.ts';
import {
	inboxActiveFilters,
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

describe('inbox filters', () => {
	/* The open inbox is the server's default, not a filter the reader chose, so
	   it never counts as narrowing the set. */
	it('counts only the filters the reader chose', () => {
		expect(inboxActiveFilters('', '')).toBe(0);
		expect(inboxActiveFilters('unread', '')).toBe(1);
		expect(inboxActiveFilters('', 'agent-run-failed')).toBe(1);
		expect(inboxActiveFilters('unread', 'agent-run-failed')).toBe(2);
	});
});

describe('inbox selection', () => {
	/* Archiving the open record changes it in place on the page; the drawer
	   reads the loaded set, so it survives the change it just made. */
	it('keeps resolving a record the open inbox would no longer list', () => {
		const items = [item('a', 'archived'), item('b', 'unread')];
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
