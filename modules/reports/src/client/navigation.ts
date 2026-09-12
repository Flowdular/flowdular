import type { NavigationContribution, WorkspaceSlot } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { REPORTS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const REPORTS_VIEWS = {
	reports: 'reports',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const reportsNavigation: readonly NavigationContribution[] = [
	{
		id: 'reports.navigation',
		viewId: REPORTS_VIEWS.reports,
		group: 'Administration',
		get label() {
			return t('reports.navigation.label');
		},
		glyph: 'activity',
		get description() {
			return t('reports.navigation.description');
		},
		scope: REPORTS_PERMISSIONS.read,
		order: 70,
	},
];

export const REPORTS_SUMMARY_WIDGET: {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
} = {
	id: 'reports.dashboard.reports-summary',
	slot: 'dashboard.metrics',
	scope: REPORTS_PERMISSIONS.read,
	order: 30,
};
