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
		/* The workspace-wide switch; off until the loaded settings say otherwise. */
		emailDelivery: false,
		status: cell<ScreenStatus>('idle'),
		error: '',
		/* Which switch is saving: a kind, the workspace-wide 'email', or none. */
		busyKind: cell<NotificationKind | 'email' | ''>(''),
		results: cell<Readonly<Record<string, SaveResult>>>({}),
	});
	return { store, state: store.state };
}

export interface EmailDeliverySwitchInput {
	readonly status: ScreenStatus;
	readonly canManage: boolean;
	readonly busy: boolean;
}

export interface EmailDeliverySwitchState {
	readonly shown: boolean;
	readonly disabled: boolean;
}

/**
 * The workspace-wide e-mail switch. It has no stored row to fall back on the
 * way a kind does, so before the load answers and after one that failed the
 * screen would show the store's `false` as the member's own answer and write
 * that answer back on the first click.
 */
export function emailDeliverySwitchState(
	input: EmailDeliverySwitchInput,
): EmailDeliverySwitchState {
	const loaded = input.status === 'idle';
	return {
		shown: loaded,
		disabled: !input.canManage || input.busy || !loaded,
	};
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
