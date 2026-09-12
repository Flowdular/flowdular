import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { NOTIFICATIONS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'notifications.navigation',
			label: 'Notifications Core',
			href: '/notifications',
			order: 50,
			permission: NOTIFICATIONS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(NOTIFICATIONS_PERMISSIONS),
} satisfies RegisteredModule;

export { NOTIFICATIONS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A publisher imports the identifier and the types
   from here and resolves the implementation through the capability registry;
   nothing else in this module is meant to be imported by another one. */
export { NOTIFICATIONS_PUBLISH_CAPABILITY } from './domain/publish.ts';
export type {
	NotificationPublisher,
	NotificationPublishInput,
	NotificationPublishResult,
} from './domain/publish.ts';

export {
	NOTIFICATION_KINDS,
	DELIVERY_STATUSES,
	DELIVERY_ERROR_CLASSES,
	INBOX_STATUSES,
	SUBSCRIPTION_STATUSES,
} from './domain/types.ts';
export type {
	DeliveryAttempt,
	DeliveryErrorClass,
	DeliveryStatus,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookEventPayload,
	WebhookSubscription,
	WebhookSubscriptionSecret,
	WebhookSubscriptionStatus,
} from './domain/types.ts';

/* The receiver half of the signing scheme, so a customer and a test verify a
   delivery with the code that produced it. */
export {
	verifyOutboundSignature,
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_SIGNATURE_VERSION,
	WEBHOOK_TIMESTAMP_HEADER,
} from './services/signature.ts';
export type { OutboundSignatureCheck } from './services/signature.ts';

export { NotificationsServiceError } from './services/service-error.ts';
