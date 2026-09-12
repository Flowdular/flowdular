import type { NavigationContribution, WorkspaceSlot } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { APPROVALS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const APPROVALS_VIEWS = {
	inbox: 'approvals',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const approvalsNavigation: readonly NavigationContribution[] = [
	{
		id: 'approvals.navigation.inbox',
		viewId: APPROVALS_VIEWS.inbox,
		group: 'Workspace',
		get label() {
			return t('approvals.navigation.inbox');
		},
		glyph: 'check',
		get description() {
			return t('approvals.navigation.inboxDescription');
		},
		scope: APPROVALS_PERMISSIONS.read,
		order: 25,
	},
];

export const APPROVALS_PENDING_WIDGET: {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
} = {
	id: 'approvals.dashboard.pending-count',
	slot: 'dashboard.metrics',
	scope: APPROVALS_PERMISSIONS.read,
	order: 25,
};
