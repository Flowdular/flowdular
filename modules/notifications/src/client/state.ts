import { cell, createStore } from 'segment-state';
import type {
	DeliveryAttempt,
	DeliveryStatus,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookSubscription,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export interface SaveResult {
	readonly ok: boolean;
	readonly message: string;
}

export function createInboxClientState() {
	const store = createStore({
		items: cell<readonly NotificationsInbox[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		/* '' keeps the default inbox: everything the member has not archived. */
		statusFilter: cell<NotificationsInboxStatus | ''>(''),
		kindFilter: cell<NotificationKind | ''>(''),
		filtersOpen: false,
		selectedId: cell<string | null>(null),
	});
	return { store, state: store.state };
}

export function createPreferencesClientState() {
	const store = createStore({
		kinds: cell<readonly NotificationKind[]>([]),
		preferences: cell<readonly NotificationPreference[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		busyKind: cell<NotificationKind | ''>(''),
		results: cell<Readonly<Record<string, SaveResult>>>({}),
	});
	return { store, state: store.state };
}

/** Which manage action is waiting for its confirmation dialog. */
export type WebhookConfirm = 'rotate' | 'disable' | 'delete';

export function createWebhooksClientState() {
	const store = createStore({
		subscriptions: cell<readonly WebhookSubscription[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<WebhookSubscription['status'] | ''>(''),
		filtersOpen: false,
		editorOpen: false,
		selectedId: '',
		formSession: 0,
		/* Held only until the drawer closes; the server never returns it again. */
		revealedSecret: '',
		confirm: cell<WebhookConfirm | null>(null),
	});
	return { store, state: store.state };
}

export function createDeliveriesClientState() {
	const store = createStore({
		deliveries: cell<readonly DeliveryAttempt[]>([]),
		subscriptions: cell<readonly WebhookSubscription[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<DeliveryStatus | ''>(''),
		subscriptionFilter: '',
		filtersOpen: false,
		replayId: cell<string | null>(null),
	});
	return { store, state: store.state };
}

/** The subscription name behind a delivery, or its id when names are not readable. */
export function subscriptionNames(
	subscriptions: readonly WebhookSubscription[],
): ReadonlyMap<string, string> {
	return new Map(
		subscriptions.map((subscription) => [subscription.id, subscription.name]),
	);
}
