import type {
	DeliveryAttempt,
	DeliveryRouting,
	DeliveryStatus,
	MemberNotificationSettings,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookSubscription,
	WebhookSubscriptionStatus,
} from '../domain/types.ts';
import type { EncryptedSecret } from './secret-vault.ts';

/** A subscription with its sealed secret. Never leaves the service layer. */
export interface StoredWebhookSubscription extends WebhookSubscription {
	readonly secret: EncryptedSecret;
}

export interface InboxFilters {
	readonly status?: NotificationsInboxStatus | undefined;
	readonly kind?: NotificationKind | undefined;
}

export interface DeliveryFilters {
	readonly status?: DeliveryStatus | undefined;
	readonly subscriptionId?: string | undefined;
}

export interface CompleteDeliveryInput {
	readonly tenantId: string;
	readonly id: string;
	readonly status: Exclude<DeliveryStatus, 'pending'>;
	readonly completedAt: number;
	readonly responseStatus: number | null;
	readonly errorClass: string | null;
}

export interface ClaimDeliveryInput {
	readonly tenantId: string;
	readonly id: string;
	/** Claim stamp, and the due bound: an attempt scheduled later is not taken. */
	readonly now: number;
	/** A claim stamped at or before this was abandoned and may be taken over. */
	readonly strandedBefore: number;
}

/**
 * One published event, written in a single tenant-scoped write transaction.
 * The two builders are pure: the service decides what a row looks like, the
 * adapter decides when it is written and under which transaction.
 */
export interface PublishEventInput {
	readonly tenantId: string;
	readonly kind: NotificationKind;
	readonly sourceRef: string;
	readonly recipients: readonly string[];
	readonly inboxItem: (recipientAccountId: string) => NotificationsInbox;
	readonly delivery: (subscription: WebhookSubscription) => DeliveryAttempt;
	/** Queued for every addressed member who turned e-mail delivery on. */
	readonly emailDelivery: (item: NotificationsInbox) => DeliveryAttempt;
}

export interface PublishEventResult {
	readonly inboxItemIds: readonly string[];
	readonly deliveryIds: readonly string[];
}

/**
 * Where a keyset page ended. Both columns are written once and never updated,
 * so a walk resumed from one cannot revisit or skip a row while the table is
 * still being written to.
 */
export interface ExportCursor {
	readonly createdAt: number;
	readonly id: string;
}

/**
 * The persistence port. Async and database agnostic: the PostgreSQL statements,
 * the tenant transactions and the background lease live in the adapter.
 */
export interface NotificationsRepository {
	/**
	 * Idempotent on (tenantId, kind, sourceRef). A repeat writes nothing and
	 * answers with the identifiers the first publication created.
	 */
	publish(input: PublishEventInput): Promise<PublishEventResult>;

	listInbox(
		tenantId: string,
		recipientAccountId: string,
		filters: InboxFilters,
		limit: number,
	): Promise<readonly NotificationsInbox[]>;
	countUnreadInbox(
		tenantId: string,
		recipientAccountId: string,
	): Promise<number>;
	getInboxItem(
		tenantId: string,
		recipientAccountId: string,
		id: string,
	): Promise<NotificationsInbox | null>;
	/**
	 * The item one published event wrote for one member, by the natural key the
	 * publication is idempotent on. The e-mail channel reads the body from it at
	 * send time instead of copying it onto the attempt row.
	 */
	findInboxItem(
		tenantId: string,
		recipientAccountId: string,
		kind: NotificationKind,
		sourceRef: string,
	): Promise<NotificationsInbox | null>;
	setInboxStatus(
		tenantId: string,
		recipientAccountId: string,
		id: string,
		status: NotificationsInboxStatus,
		readAt: string | null,
	): Promise<NotificationsInbox | null>;
	/**
	 * Writes the items an event produced outside a publication, skipping repeats
	 * and, exactly like `publish`, every recipient who disabled that kind.
	 */
	appendInboxItems(
		tenantId: string,
		records: readonly NotificationsInbox[],
		emailDelivery: (item: NotificationsInbox) => DeliveryAttempt,
	): Promise<readonly string[]>;
	/**
	 * Every inbox item of one workspace, oldest first, one keyset page at a
	 * time. This is the workspace export of `notifications.core.inbox`, so it
	 * crosses recipients; the member-facing reads never do.
	 */
	exportInboxPage(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly NotificationsInbox[]>;
	/**
	 * Removes at most `limit` inbox items created strictly before `before`.
	 * Nothing else deletes an item by age, so this is the whole retention path
	 * of the class.
	 */
	deleteInboxItemsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;

	listPreferences(
		tenantId: string,
		recipientAccountId: string,
	): Promise<readonly NotificationPreference[]>;
	savePreference(
		record: NotificationPreference,
	): Promise<NotificationPreference>;
	/** Null when the member never saved one; the caller applies the defaults. */
	getMemberSettings(
		tenantId: string,
		recipientAccountId: string,
	): Promise<MemberNotificationSettings | null>;
	saveMemberSettings(
		record: MemberNotificationSettings,
	): Promise<MemberNotificationSettings>;

	listSubscriptions(
		tenantId: string,
	): Promise<readonly StoredWebhookSubscription[]>;
	getSubscription(
		tenantId: string,
		id: string,
	): Promise<StoredWebhookSubscription | null>;
	/** Null when the normalized name is already taken in the tenant. */
	createSubscription(
		record: StoredWebhookSubscription,
	): Promise<StoredWebhookSubscription | null>;
	/** Null when the row is gone, `'conflict'` when the new name is taken. */
	updateSubscription(
		record: Pick<
			WebhookSubscription,
			| 'tenantId'
			| 'id'
			| 'name'
			| 'url'
			| 'events'
			| 'description'
			| 'updatedAt'
		>,
	): Promise<StoredWebhookSubscription | null | 'conflict'>;
	setSubscriptionStatus(
		tenantId: string,
		id: string,
		status: WebhookSubscriptionStatus,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null>;
	/**
	 * Moves the subscription to disabled and drops its pending attempts in the
	 * same write, so no queued delivery can leave after the subscription stopped
	 * accepting events. The ledger of completed attempts is untouched.
	 */
	disableSubscription(
		tenantId: string,
		id: string,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null>;
	rotateSubscriptionSecret(
		tenantId: string,
		id: string,
		secret: EncryptedSecret,
		fingerprint: string,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null>;
	/** Deletes the subscription and its pending attempts; the ledger stays. */
	deleteSubscription(tenantId: string, id: string): Promise<boolean>;
	stampSubscriptionDelivery(
		tenantId: string,
		id: string,
		at: number,
	): Promise<void>;

	listDeliveries(
		tenantId: string,
		filters: DeliveryFilters,
		limit: number,
	): Promise<readonly DeliveryAttempt[]>;
	getDelivery(tenantId: string, id: string): Promise<DeliveryAttempt | null>;
	/** Null when an attempt with the same sequence and number already exists. */
	appendDelivery(record: DeliveryAttempt): Promise<DeliveryAttempt | null>;
	/**
	 * Takes one due attempt for this process, under the tenant the routing row
	 * named, and returns the row it claimed. Null when the attempt moved on, is
	 * not due yet, or is held by a claim that has not gone stale: that is what
	 * keeps a second process draining the same queue from repeating the request.
	 */
	claimDelivery(input: ClaimDeliveryInput): Promise<DeliveryAttempt | null>;
	/**
	 * Returns a claimed attempt to the queue at `scheduledFor`. The attempt
	 * number, the outcome and every other ledger field stay untouched, so a
	 * subscription that is holding its queue still counts no attempt.
	 */
	releaseDelivery(
		tenantId: string,
		id: string,
		scheduledFor: number,
	): Promise<boolean>;
	/** Moves one open attempt, pending or claimed, to a terminal state. */
	completeDelivery(input: CompleteDeliveryInput): Promise<boolean>;
	/** Highest attempt run recorded for one event on one delivery target. */
	latestDeliverySequence(
		attempt: Pick<
			DeliveryAttempt,
			| 'tenantId'
			| 'channel'
			| 'subscriptionId'
			| 'recipientAccountId'
			| 'kind'
			| 'sourceRef'
		>,
	): Promise<number>;

	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listDueDeliveries(
		now: number,
		limit: number,
	): Promise<readonly DeliveryRouting[]>;
	/**
	 * Cross-tenant claims stamped at or before `before`, whose claimant never
	 * came back. A claim is invisible to the due query, so a process that died
	 * mid-send would strand its rows without this second, equally bounded read.
	 */
	listStrandedDeliveries(
		before: number,
		limit: number,
	): Promise<readonly DeliveryRouting[]>;
	/**
	 * Cross-tenant tenant list for retention, routing columns only. `after` is
	 * the last tenant id the previous page ended on, so a deployment with more
	 * tenants than one page still gets every one of them swept in turn.
	 */
	listDeliveryTenants(limit: number, after: string): Promise<readonly string[]>;
	deleteCompletedDeliveriesBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	/**
	 * Every delivery attempt of one workspace, oldest first, one keyset page at
	 * a time. The key is the row's own creation, not the mutable schedule or
	 * completion the queue works from.
	 */
	exportDeliveriesPage(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly DeliveryAttempt[]>;
}
