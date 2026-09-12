import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createDocumentsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createDocumentsClientContribution } from './contribution.tsrx';
export type { DocumentsClientContributionOptions } from './contribution.tsrx';
export { documentsNavigation, DOCUMENTS_VIEW } from './navigation.ts';
export { DocumentsView } from './DocumentsView.tsrx';
export { DocumentUploader } from './DocumentUploader.tsrx';
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
