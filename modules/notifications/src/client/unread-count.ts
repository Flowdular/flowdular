import { cell, createStore } from 'segment-state';
import { loadUnreadCount } from './api.ts';

/* One count behind the topbar badge and the inbox screen. The screen reports
   what it just changed, so the badge follows a real event instead of polling
   for one. */
const store = createStore({ unread: cell(0) });

export const unreadCount = store.state.unread;

export function clearUnreadCount(): void {
	store.set(store.state.unread, 0, 'notifications/unread-cleared');
}

export async function refreshUnreadCount(): Promise<void> {
	try {
		store.set(
			store.state.unread,
			await loadUnreadCount(),
			'notifications/unread-loaded',
		);
	} catch {
		/* The badge is an accessory. A failed count keeps the last one rather than
   raising an error across the whole workspace. */
	}
}
