import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { ACCESS_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const ACCESS_VIEWS = {
	review: 'access-review',
	activity: 'access-activity',
	attestations: 'access-attestations',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const accessNavigation: readonly NavigationContribution[] = [
	{
		id: 'access.navigation.review',
		viewId: ACCESS_VIEWS.review,
		group: 'Administration',
		get label() {
			return t('access.navigation.review');
		},
		glyph: 'shield',
		get description() {
			return t('access.navigation.reviewDescription');
		},
		scope: ACCESS_PERMISSIONS.read,
		order: 70,
	},
	{
		id: 'access.navigation.activity',
		viewId: ACCESS_VIEWS.activity,
		group: 'Administration',
		get label() {
			return t('access.navigation.activity');
		},
		glyph: 'activity',
		get description() {
			return t('access.navigation.activityDescription');
		},
		scope: ACCESS_PERMISSIONS.read,
		order: 71,
	},
	{
		id: 'access.navigation.attestations',
		viewId: ACCESS_VIEWS.attestations,
		group: 'Administration',
		get label() {
			return t('access.navigation.attestations');
		},
		glyph: 'check',
		get description() {
			return t('access.navigation.attestationsDescription');
		},
		scope: ACCESS_PERMISSIONS.read,
		order: 72,
	},
];
