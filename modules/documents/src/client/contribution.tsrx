import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import { DocumentsView } from './DocumentsView.tsrx';
import './documents.css';
import {
	documentsNavigation,
	DOCUMENT_TEMPLATES_VIEW,
	DOCUMENTS_VIEW,
} from './navigation.ts';
import { TemplatesView } from './TemplatesView.tsrx';

export interface DocumentsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createDocumentsClientContribution(
	options: DocumentsClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(DOCUMENTS_PERMISSIONS.manage);
	const canManageTemplates = options.scopes.includes(
		DOCUMENTS_PERMISSIONS.templatesManage,
	);
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
			{
				id: DOCUMENT_TEMPLATES_VIEW,
				render: () =>
					<TemplatesView
						csrfToken={options.csrfToken}
						canManage={canManageTemplates}
					/>,
			},
		],
	};
}
