import { cell, createStore } from 'segment-state';
import type {
	DeliveryAttempt,
	DeliveryStatus,
	InboxTransition,
	InboxTransitionOutcome,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookSubscription,
} from '../domain/types.ts';

export type SortDirection = 'asc' | 'desc';

/**
 * The pages a keyset-paged screen has walked. `cursors[i]` is the cursor that
 * opens page `i`; page 0 has none, and a page past the last one loaded has no
 * cursor yet, so the screen can go back to any page it saw and forward one.
 */
export interface CursorStack {
	readonly cursors: readonly string[];
	/** Whether a page follows the last one loaded. */
	readonly hasMore: boolean;
}

export const FIRST_PAGE: CursorStack = { cursors: [''], hasMore: false };

/** The cursor that opens `pageIndex`, or null when the screen has not reached it. */
export function pageCursor(
	stack: CursorStack,
	pageIndex: number,
): string | null {
	return stack.cursors[pageIndex] ?? null;
}

/**
 * What the page just loaded said about the page after it. Pages beyond it are
 * forgotten: they were reached through a cursor this response replaces.
 */
export function pageLoaded(
	stack: CursorStack,
	pageIndex: number,
	nextCursor: string | null,
): CursorStack {
	const kept = stack.cursors.slice(0, pageIndex + 1);
	return {
		cursors: nextCursor === null ? kept : [...kept, nextCursor],
		hasMore: nextCursor !== null,
	};
}

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
		pageIndex: 0,
		pageSize: 25,
		pages: cell<CursorStack>(FIRST_PAGE),
		/* The open inbox came back empty while archived items exist: the default
		   rule is hiding them, so the table reads as narrowed, not as a first run. */
		archivedHidden: false,
		/* Rows checked on the page; every new listing starts with none. */
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		confirmArchiveMany: false,
	});
	return { store, state: store.state };
}

/**
 * The checked rows one bulk change may name, by the same rule the row actions
 * follow: mark-read is for unread rows, archive for rows not archived yet.
 */
export function transitionableIds(
	items: readonly NotificationsInbox[],
	selected: ReadonlySet<string>,
	transition: InboxTransition,
): readonly string[] {
	return items
		.filter(
			(item) =>
				selected.has(item.id) &&
				(transition === 'mark-read'
					? item.status === 'unread'
					: item.status !== 'archived'),
		)
		.map((item) => item.id);
}

/** How many ids each outcome covered, for the notice after a bulk change. */
export function transitionOutcomeCounts(
	outcomes: readonly InboxTransitionOutcome[],
): {
	readonly updated: number;
	readonly missing: number;
	readonly refused: number;
} {
	let updated = 0;
	let missing = 0;
	let refused = 0;
	for (const entry of outcomes) {
		if (entry.outcome === 'updated') updated += 1;
		else if (entry.outcome === 'not-found') missing += 1;
		else refused += 1;
	}
	return { updated, missing, refused };
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
		/* The term the rows on screen answer; the box may be ahead of it. */
		appliedQuery: '',
		statusFilter: cell<WebhookSubscription['status'] | ''>(''),
		direction: cell<SortDirection>('asc'),
		pageIndex: 0,
		pageSize: 25,
		pages: cell<CursorStack>(FIRST_PAGE),
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
		appliedQuery: '',
		statusFilter: cell<DeliveryStatus | ''>(''),
		subscriptionFilter: '',
		direction: cell<SortDirection>('desc'),
		pageIndex: 0,
		pageSize: 25,
		pages: cell<CursorStack>(FIRST_PAGE),
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

/**
 * The subscriptions the ledger filter offers: every one the reader may see by
 * name, plus any the page on screen names that the list did not, so the filter
 * still works when the list is not readable or a row outlived its subscription.
 */
export function subscriptionOptions(
	subscriptions: readonly WebhookSubscription[],
	deliveries: readonly DeliveryAttempt[],
): readonly { readonly value: string; readonly label: string }[] {
	const names = subscriptionNames(subscriptions);
	const ids = new Set(names.keys());
	for (const delivery of deliveries) {
		if (delivery.subscriptionId !== null) ids.add(delivery.subscriptionId);
	}
	return [...ids].map((id) => ({ value: id, label: names.get(id) ?? id }));
}

/** Whether the search box is ahead of the term the rows answer. */
export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}
