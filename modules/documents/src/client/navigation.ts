import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';

/** The view id the navigation entry points at; it equals the URL slug. */
export const DOCUMENTS_VIEW = 'documents';

/* Labels are read every render, so a locale change reaches an entry the shell
   built once. */
export const documentsNavigation: readonly NavigationContribution[] = [
	{
		id: 'documents.navigation',
		viewId: DOCUMENTS_VIEW,
		group: 'Workspace',
		get label() {
			return t('documents.navigation.label');
		},
		glyph: 'file-text',
		get description() {
			return t('documents.navigation.description');
		},
		scope: DOCUMENTS_PERMISSIONS.read,
		order: 30,
	},
];
