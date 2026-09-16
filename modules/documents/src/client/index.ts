import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createDocumentsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createDocumentsClientContribution } from './contribution.tsrx';
export type { DocumentsClientContributionOptions } from './contribution.tsrx';
export {
	documentsNavigation,
	DOCUMENT_TEMPLATES_VIEW,
	DOCUMENTS_VIEW,
} from './navigation.ts';
export { DocumentsView } from './DocumentsView.tsrx';
export { DocumentUploader } from './DocumentUploader.tsrx';
export { DocumentDetailsDrawer } from './DocumentDetailsDrawer.tsrx';
export { TemplatesView } from './TemplatesView.tsrx';
export { TemplateEditorDrawer } from './TemplateEditorDrawer.tsrx';
export type { DocumentUploadValue } from './DocumentUploader.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
