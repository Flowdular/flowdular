import type {
	NotificationKind,
	NotificationsInbox,
	NotificationsInboxStatus,
} from '../domain/types.ts';

/**
 * Filters the reader chose. The default inbox is everything the member has not
 * archived, which the server applies on its own; it is not one of them.
 */
export function inboxActiveFilters(
	statusFilter: NotificationsInboxStatus | '',
	kindFilter: NotificationKind | '',
): number {
	return (statusFilter === '' ? 0 : 1) + (kindFilter === '' ? 0 : 1);
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
