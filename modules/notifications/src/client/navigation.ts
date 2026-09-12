import type {
	AccountMenuContribution,
	NavigationContribution,
	WorkspaceSlot,
} from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { NOTIFICATIONS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const NOTIFICATIONS_VIEWS = {
	inbox: 'notifications-inbox',
	preferences: 'notifications-preferences',
	webhooks: 'notifications-webhooks',
	deliveries: 'notifications-deliveries',
} as const;

/* The shell's own `viewHref` is internal, so an entry rendered outside a view
   builds the same address: the installation path, the workspace slug the shell
   keeps in the URL, then the view id. A single segment under the base is the
   view itself, and the shell resolves that slugless form against the open
   workspace. */
export function workspaceViewHref(
	viewId: string,
	pathname: string,
	basePath: string,
): string {
	const segments = pathname.split('/').filter(Boolean);
	const inWorkspace =
		segments[0] === basePath.slice(1) ? segments.slice(1) : [];
	const workspaceSlug = inWorkspace.length > 1 ? inWorkspace[0] : null;
	return workspaceSlug === null
		? basePath + '/' + viewId
		: basePath + '/' + workspaceSlug + '/' + viewId;
}

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const notificationsNavigation: readonly NavigationContribution[] = [
	{
		id: 'notifications.navigation.inbox',
		viewId: NOTIFICATIONS_VIEWS.inbox,
		group: 'Workspace',
		get label() {
			return t('notifications.navigation.inbox');
		},
		glyph: 'activity',
		get description() {
			return t('notifications.navigation.inboxDescription');
		},
		scope: NOTIFICATIONS_PERMISSIONS.read,
		order: 20,
	},
	{
		id: 'notifications.navigation.webhooks',
		viewId: NOTIFICATIONS_VIEWS.webhooks,
		group: 'Administration',
		get label() {
			return t('notifications.navigation.webhooks');
		},
		glyph: 'plug',
		get description() {
			return t('notifications.navigation.webhooksDescription');
		},
		scope: NOTIFICATIONS_PERMISSIONS.webhooksRead,
		order: 60,
	},
	{
		id: 'notifications.navigation.deliveries',
		viewId: NOTIFICATIONS_VIEWS.deliveries,
		group: 'Administration',
		get label() {
			return t('notifications.navigation.deliveries');
		},
		glyph: 'activity',
		get description() {
			return t('notifications.navigation.deliveriesDescription');
		},
		scope: NOTIFICATIONS_PERMISSIONS.deliveriesRead,
		order: 61,
	},
];

/* Preferences belong to the person, not to the workspace, so they are reached
   from the account menu like the profile screen. */
export const notificationsAccountMenu: readonly AccountMenuContribution[] = [
	{
		id: 'notifications.account-menu.preferences',
		viewId: NOTIFICATIONS_VIEWS.preferences,
		get label() {
			return t('notifications.navigation.preferences');
		},
		get description() {
			return t('notifications.navigation.preferencesDescription');
		},
		glyph: 'settings',
		scope: NOTIFICATIONS_PERMISSIONS.read,
		order: 20,
	},
];

export const NOTIFICATIONS_UNREAD_WIDGET: {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
} = {
	id: 'notifications.topbar.unread',
	slot: 'topbar.actions',
	scope: NOTIFICATIONS_PERMISSIONS.read,
	order: 10,
};
