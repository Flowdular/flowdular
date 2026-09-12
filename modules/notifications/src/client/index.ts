import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createNotificationsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createNotificationsClientContribution } from './contribution.tsrx';
export type { NotificationsClientContributionOptions } from './contribution.tsrx';
export { DeliveriesView } from './DeliveriesView.tsrx';
export { NotificationPreferencesView } from './NotificationPreferencesView.tsrx';
export { NotificationsInboxView } from './NotificationsInboxView.tsrx';
export { UnreadCountWidget } from './UnreadCountWidget.tsrx';
export { WebhooksView } from './WebhooksView.tsrx';
export {
	NOTIFICATIONS_UNREAD_WIDGET,
	NOTIFICATIONS_VIEWS,
	notificationsAccountMenu,
	notificationsNavigation,
} from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
