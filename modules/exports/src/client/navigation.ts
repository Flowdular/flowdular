import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { EXPORTS_PERMISSIONS } from '../acl/permissions.ts';

/** The view id the navigation entry points at; it equals the URL slug. */
export const EXPORTS_VIEW = 'exports';

/* Labels are read every render, so a locale change reaches an entry the shell
   built once. */
export const exportsNavigation: readonly NavigationContribution[] = [
	{
		id: 'exports.navigation',
		viewId: EXPORTS_VIEW,
		group: 'Operations',
		get label() {
			return t('exports.navigation.label');
		},
		glyph: 'download',
		get description() {
			return t('exports.navigation.description');
		},
		scope: EXPORTS_PERMISSIONS.read,
		order: 45,
	},
];
