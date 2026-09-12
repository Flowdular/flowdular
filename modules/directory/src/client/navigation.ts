import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { DIRECTORY_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const DIRECTORY_VIEWS = {
	tokens: 'directory-tokens',
	groups: 'directory-groups',
	log: 'directory-log',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const directoryNavigation: readonly NavigationContribution[] = [
	{
		id: 'directory.navigation.tokens',
		viewId: DIRECTORY_VIEWS.tokens,
		group: 'Administration',
		get label() {
			return t('directory.navigation.tokens');
		},
		glyph: 'key',
		get description() {
			return t('directory.navigation.tokensDescription');
		},
		scope: DIRECTORY_PERMISSIONS.read,
		order: 70,
	},
	{
		id: 'directory.navigation.groups',
		viewId: DIRECTORY_VIEWS.groups,
		group: 'Administration',
		get label() {
			return t('directory.navigation.groups');
		},
		glyph: 'users',
		get description() {
			return t('directory.navigation.groupsDescription');
		},
		scope: DIRECTORY_PERMISSIONS.provisioningRead,
		order: 71,
	},
	{
		id: 'directory.navigation.log',
		viewId: DIRECTORY_VIEWS.log,
		group: 'Administration',
		get label() {
			return t('directory.navigation.log');
		},
		glyph: 'activity',
		get description() {
			return t('directory.navigation.logDescription');
		},
		scope: DIRECTORY_PERMISSIONS.provisioningRead,
		order: 72,
	},
];
