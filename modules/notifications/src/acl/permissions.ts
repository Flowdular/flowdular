export const NOTIFICATIONS_PERMISSIONS = {
	read: 'notifications.inbox.read',
	manage: 'notifications.inbox.manage',
	webhooksRead: 'notifications.webhooks.read',
	webhooksManage: 'notifications.webhooks.manage',
	deliveriesRead: 'notifications.deliveries.read',
} as const;

export const permissions = Object.freeze(
	Object.values(NOTIFICATIONS_PERMISSIONS),
);
