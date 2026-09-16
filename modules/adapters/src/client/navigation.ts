import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { ADAPTERS_PERMISSIONS } from '../acl/permissions.ts';

/** The view id the navigation entry points at; it equals the URL slug. */
export const DATA_ADAPTERS_VIEW = 'data-adapters';

/* Labels are read every render, so a locale change reaches an entry the shell
   built once. */
export const adaptersNavigation: readonly NavigationContribution[] = [
	{
		id: 'adapters.navigation',
		viewId: DATA_ADAPTERS_VIEW,
		group: 'Administration',
		section: 'integrations',
		get label() {
			return t('adapters.navigation.label');
		},
		glyph: 'refresh',
		get description() {
			return t('adapters.navigation.description');
		},
		scope: ADAPTERS_PERMISSIONS.read,
		order: 72,
	},
];
