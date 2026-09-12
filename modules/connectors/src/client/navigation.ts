import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { CONNECTORS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const CONNECTORS_VIEWS = {
	instances: 'connectors',
	calls: 'connector-calls',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const connectorsNavigation: readonly NavigationContribution[] = [
	{
		id: 'connectors.navigation.instances',
		viewId: CONNECTORS_VIEWS.instances,
		group: 'Administration',
		get label() {
			return t('connectors.navigation.instances');
		},
		glyph: 'plug',
		get description() {
			return t('connectors.navigation.instancesDescription');
		},
		scope: CONNECTORS_PERMISSIONS.read,
		order: 70,
	},
	{
		id: 'connectors.navigation.calls',
		viewId: CONNECTORS_VIEWS.calls,
		group: 'Administration',
		get label() {
			return t('connectors.navigation.calls');
		},
		glyph: 'activity',
		get description() {
			return t('connectors.navigation.callsDescription');
		},
		scope: CONNECTORS_PERMISSIONS.read,
		order: 71,
	},
];
