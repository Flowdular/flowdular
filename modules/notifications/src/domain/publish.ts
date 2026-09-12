import type { NotificationKind } from './types.ts';

/**
 * The public cross-module surface. A publisher resolves it through
 * `context.capabilities.get<NotificationPublisher>(NOTIFICATIONS_PUBLISH_CAPABILITY)`
 * and continues without notifying when it is absent.
 */
export const NOTIFICATIONS_PUBLISH_CAPABILITY = 'notifications.publish.v1';

export interface NotificationPublishInput {
	readonly tenantId: string;
	readonly kind: NotificationKind;
	/** Publisher module id, for example `agents.core`. */
	readonly sourceModule: string;
	/** Stable reference to the publisher's record, for example a run id. */
	readonly sourceRef: string;
	readonly title: string;
	readonly body?: string;
	/** Account ids of the members the event is addressed to. */
	readonly recipients: readonly string[];
}

export interface NotificationPublishResult {
	/** Ascending by id, so a repeat returns arrays equal to the first call's. */
	readonly inboxItemIds: readonly string[];
	readonly deliveryIds: readonly string[];
}

export interface NotificationPublisher {
	/**
	 * Idempotent on (tenantId, kind, sourceRef): a repeat writes nothing and
	 * returns the identifiers the first call created. Member preferences decide
	 * whether an inbox item is written; webhook deliveries are unaffected by them.
	 */
	publish(input: NotificationPublishInput): Promise<NotificationPublishResult>;
}

/** Longest values the capability accepts; over any of them is a rejection. */
export const PUBLISH_LIMITS = {
	sourceModule: 64,
	sourceRef: 200,
	title: 200,
	body: 4_000,
	recipients: 64,
	accountId: 128,
} as const;
