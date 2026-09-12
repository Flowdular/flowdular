import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { AUDIT_PERMISSIONS } from '../acl/permissions.ts';

/** The view ids the contribution registers and every entry points at. */
export const AUDIT_VIEWS = {
	dataClasses: 'audit-data-classes',
	sweeps: 'audit-sweeps',
	exports: 'audit-exports',
	holds: 'audit-holds',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const auditNavigation: readonly NavigationContribution[] = [
	{
		id: 'audit.navigation.data-classes',
		viewId: AUDIT_VIEWS.dataClasses,
		group: 'Administration',
		get label() {
			return t('audit.navigation.dataClasses');
		},
		glyph: 'shield',
		get description() {
			return t('audit.navigation.dataClassesDescription');
		},
		scope: AUDIT_PERMISSIONS.read,
		order: 70,
	},
	{
		id: 'audit.navigation.sweeps',
		viewId: AUDIT_VIEWS.sweeps,
		group: 'Administration',
		get label() {
			return t('audit.navigation.sweeps');
		},
		glyph: 'refresh',
		get description() {
			return t('audit.navigation.sweepsDescription');
		},
		scope: AUDIT_PERMISSIONS.read,
		order: 71,
	},
	{
		id: 'audit.navigation.exports',
		viewId: AUDIT_VIEWS.exports,
		group: 'Administration',
		get label() {
			return t('audit.navigation.exports');
		},
		glyph: 'download',
		get description() {
			return t('audit.navigation.exportsDescription');
		},
		scope: AUDIT_PERMISSIONS.read,
		order: 72,
	},
	{
		id: 'audit.navigation.holds',
		viewId: AUDIT_VIEWS.holds,
		group: 'Administration',
		get label() {
			return t('audit.navigation.holds');
		},
		glyph: 'key',
		get description() {
			return t('audit.navigation.holdsDescription');
		},
		/* The list is behind audit.holds.manage, so a principal holding only the
		   read permission is not offered a screen that answers 403. */
		scope: AUDIT_PERMISSIONS.holdsManage,
		order: 73,
	},
];
