import type {
	NotificationKind,
	NotificationsInbox,
	NotificationsInboxStatus,
} from '../domain/types.ts';

export interface InboxListing {
	/** The rows the table renders. */
	readonly visible: readonly NotificationsInbox[];
	/** Something is held back, so an empty table is a narrowed set, not a first run. */
	readonly filtered: boolean;
	/** Filters the reader chose. The archived rule below is not one of them. */
	readonly activeFilters: number;
}

/* The default inbox is everything the member has not archived: the server
   filters one status at a time, so that last step happens here. It narrows the
   set like any filter, so an inbox whose items are all archived reads as
   narrowed instead of empty. */
export function inboxListing(
	items: readonly NotificationsInbox[],
	statusFilter: NotificationsInboxStatus | '',
	kindFilter: NotificationKind | '',
): InboxListing {
	const visible =
		statusFilter === ''
			? items.filter((item) => item.status !== 'archived')
			: items;
	const activeFilters =
		(statusFilter === '' ? 0 : 1) + (kindFilter === '' ? 0 : 1);
	return {
		visible,
		filtered: activeFilters > 0 || visible.length !== items.length,
		activeFilters,
	};
}

export type InboxRowAction = 'open' | 'archive' | 'mark-unread';

/* Opening the record is the one action every member has, and the only way to
   reach it from the keyboard, since the row itself is not a control. A manager
   also gets the one change that moves the item out of the list being read;
   read and unread stay in the drawer, because a third button no longer fits
   the row in every locale. */
export function inboxRowActions(
	status: NotificationsInboxStatus,
	canManage: boolean,
): readonly InboxRowAction[] {
	if (!canManage) return ['open'];
	return ['open', status === 'archived' ? 'mark-unread' : 'archive'];
}

/** The drawer reads its record from everything loaded, so a row that leaves the
 * narrowed set through the change the reader just made keeps the drawer open. */
export function selectedInboxItem(
	items: readonly NotificationsInbox[],
	selectedId: string | null,
): NotificationsInbox | null {
	if (selectedId === null) return null;
	return items.find((item) => item.id === selectedId) ?? null;
}
