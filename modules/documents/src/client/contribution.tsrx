import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import { DocumentsView } from './DocumentsView.tsrx';
import { documentsNavigation, DOCUMENTS_VIEW } from './navigation.ts';

export interface DocumentsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createDocumentsClientContribution(
	options: DocumentsClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(DOCUMENTS_PERMISSIONS.manage);
	return {
		moduleId: 'documents.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: documentsNavigation,
		views: [
			{
				id: DOCUMENTS_VIEW,
				render: () =>
					<DocumentsView csrfToken={options.csrfToken} canManage={canManage} />,
			},
		],
	};
}
