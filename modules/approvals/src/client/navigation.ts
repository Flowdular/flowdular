import type { NavigationContribution, WorkspaceSlot } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { APPROVALS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const APPROVALS_VIEWS = {
	inbox: 'approvals',
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
