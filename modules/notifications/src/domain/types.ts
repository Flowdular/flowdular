/** Every event this module carries. Inbox items, preferences, subscriptions and
    deliveries all key off the same closed set. */
export const NOTIFICATION_KINDS = [
	'agent-run-completed',
	'agent-run-failed',
	'workflow-run-completed',
	'workflow-run-failed',
	'webhook-dead-letter',
	'approval-requested',
	'approval-decided',
	'meter-threshold',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const INBOX_STATUSES = ['unread', 'read', 'archived'] as const;
export type NotificationsInboxStatus = (typeof INBOX_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'disabled'] as const;
export type WebhookSubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const DELIVERY_STATUSES = [
	'pending',
	'succeeded',
	'failed',
	'dead-letter',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Stable failure classes recorded on an attempt. Never a response body. */
export const DELIVERY_ERROR_CLASSES = [
	'timeout',
	'dns',
	'egress-refused',
	'response-4xx',
	'response-5xx',
	'network',
] as const;
export type DeliveryErrorClass = (typeof DELIVERY_ERROR_CLASSES)[number];

export interface NotificationsInbox {
	readonly id: string;
	readonly tenantId: string;
	readonly recipientAccountId: string;
	readonly kind: NotificationKind;
	readonly title: string;
	readonly body: string | null;
	readonly sourceModule: string;
	readonly sourceRef: string;
	readonly status: NotificationsInboxStatus;
	readonly readAt: string | null;
	readonly createdAt: number;
}

export interface NotificationPreference {
	readonly id: string;
	readonly tenantId: string;
	readonly recipientAccountId: string;
	readonly kind: NotificationKind;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A subscription as any read path may see it: fingerprint, never the secret. */
export interface WebhookSubscription {
	readonly id: string;
	readonly tenantId: string;
	readonly name: string;
	readonly url: string;
	readonly events: readonly NotificationKind[];
	readonly secretFingerprint: string;
	readonly secretRevision: number;
	readonly status: WebhookSubscriptionStatus;
	readonly description: string | null;
	readonly lastDeliveryAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string;
}

/** Returned once, at creation and at rotation, and never read back. */
export interface WebhookSubscriptionSecret {
	readonly subscription: WebhookSubscription;
	readonly secret: string;
}

export interface CreateWebhookSubscriptionInput {
	readonly name: string;
	readonly url: string;
	readonly events: readonly NotificationKind[];
	readonly description?: string | null;
}

export interface UpdateWebhookSubscriptionInput
	extends CreateWebhookSubscriptionInput {
	readonly id: string;
}

export interface DeliveryAttempt {
	readonly id: string;
	readonly tenantId: string;
	readonly subscriptionId: string;
	readonly kind: NotificationKind;
	readonly sourceModule: string;
	readonly sourceRef: string;
	/** The published title, carried in the payload and signed with it. */
	readonly title: string;
	/** Attempt runs of one event: 1 for the original, one more per replay. */
	readonly sequence: number;
	readonly attemptNumber: number;
	readonly status: DeliveryStatus;
	readonly scheduledFor: number;
	readonly completedAt: number | null;
	readonly responseStatus: number | null;
	readonly errorClass: string | null;
	readonly payloadDigest: string;
	readonly payloadBytes: number;
	/** Publication time of the event; stable across every attempt and replay. */
	readonly occurredAt: number;
	readonly createdAt: number;
}

/** What the cross-tenant poll is allowed to learn on the background role. */
export interface DeliveryRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly scheduledFor: number;
	readonly status: DeliveryStatus;
}

/** The body signed and sent to a subscription, and rebuilt for every replay. */
export interface WebhookEventPayload {
	readonly version: 'notifications.v1';
	readonly event: NotificationKind;
	readonly tenantId: string;
	readonly subscriptionId: string;
	readonly sourceModule: string;
	readonly sourceRef: string;
	readonly title: string;
	readonly occurredAt: number;
}
