import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { NOTIFICATIONS_PERMISSIONS } from '../acl/permissions.ts';
import { DeliveriesView } from './DeliveriesView.tsrx';
import {
	NOTIFICATIONS_UNREAD_WIDGET,
	NOTIFICATIONS_VIEWS,
	notificationsAccountMenu,
	notificationsNavigation,
} from './navigation.ts';
import {
	NotificationPreferencesView,
} from './NotificationPreferencesView.tsrx';
import { NotificationsInboxView } from './NotificationsInboxView.tsrx';
import { UnreadCountWidget } from './UnreadCountWidget.tsrx';
import { WebhooksView } from './WebhooksView.tsrx';
import './notifications.css';

export interface NotificationsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createNotificationsClientContribution(
	options: NotificationsClientContributionOptions,
): ModuleClientContribution {
	const canManageInbox = options.scopes.includes(
		NOTIFICATIONS_PERMISSIONS.manage,
	);
	const canManageWebhooks = options.scopes.includes(
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	);
	const canReadWebhooks = options.scopes.includes(
		NOTIFICATIONS_PERMISSIONS.webhooksRead,
	);
	return {
		moduleId: 'notifications.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: notificationsNavigation,
		accountMenu: notificationsAccountMenu,
		views: [
			{
				id: NOTIFICATIONS_VIEWS.inbox,
				render: () =>
					<NotificationsInboxView
						csrfToken={options.csrfToken}
						canManage={canManageInbox}
					/>,
			},
			{
				id: NOTIFICATIONS_VIEWS.preferences,
				render: () =>
					<NotificationPreferencesView
						csrfToken={options.csrfToken}
						canManage={canManageInbox}
					/>,
			},
			{
				id: NOTIFICATIONS_VIEWS.webhooks,
				render: () =>
					<WebhooksView
						csrfToken={options.csrfToken}
						canManage={canManageWebhooks}
					/>,
			},
			{
				id: NOTIFICATIONS_VIEWS.deliveries,
				render: () =>
					<DeliveriesView
						csrfToken={options.csrfToken}
						canReadWebhooks={canReadWebhooks}
					/>,
			},
		],
		widgets: [
			{
				...NOTIFICATIONS_UNREAD_WIDGET,
				render: () => <UnreadCountWidget />,
			},
		],
	};
}
