import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createImportClientContribution as canonicalContribution } from './contribution.tsrx';

export { createImportClientContribution } from './contribution.tsrx';
export type { ImportClientContributionOptions } from './contribution.tsrx';
export { importNavigation, IMPORTS_VIEW } from './navigation.ts';
export { ImportsView } from './ImportsView.tsrx';
export { ImportJobDrawer } from './ImportJobDrawer.tsrx';
export { NewImportForm } from './NewImportForm.tsrx';
export type { NewImportValue } from './NewImportForm.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
