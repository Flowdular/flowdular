import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { IMPORT_PERMISSIONS } from '../acl/permissions.ts';

/** The view id the navigation entry points at; it equals the URL slug. */
export const IMPORTS_VIEW = 'imports';

/* Labels are read every render, so a locale change reaches an entry the shell
   built once. */
export const importNavigation: readonly NavigationContribution[] = [
	{
		id: 'import.navigation',
		viewId: IMPORTS_VIEW,
		group: 'Operations',
		get label() {
			return t('import.navigation.label');
		},
		glyph: 'upload',
		get description() {
			return t('import.navigation.description');
		},
		scope: IMPORT_PERMISSIONS.read,
		order: 40,
	},
];
