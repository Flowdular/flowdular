import type { NavigationContribution, WorkspaceSlot } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { METERING_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const METERING_VIEWS = {
	usage: 'metering-usage',
	limits: 'metering-limits',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const meteringNavigation: readonly NavigationContribution[] = [
	{
		id: 'metering.navigation.usage',
		viewId: METERING_VIEWS.usage,
		group: 'Administration',
		get label() {
			return t('metering.navigation.usage');
		},
		glyph: 'activity',
		get description() {
			return t('metering.navigation.usageDescription');
		},
		scope: METERING_PERMISSIONS.read,
		order: 68,
	},
	{
		id: 'metering.navigation.limits',
		viewId: METERING_VIEWS.limits,
		group: 'Administration',
		get label() {
			return t('metering.navigation.limits');
		},
		glyph: 'shield',
		get description() {
			return t('metering.navigation.limitsDescription');
		},
		scope: METERING_PERMISSIONS.read,
		order: 69,
	},
];

export const METERING_USAGE_WIDGET: {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
} = {
	id: 'metering.dashboard.usage-summary',
	slot: 'dashboard.metrics',
	scope: METERING_PERMISSIONS.read,
	order: 40,
};
