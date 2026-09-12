import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createExportsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createExportsClientContribution } from './contribution.tsrx';
export type { ExportsClientContributionOptions } from './contribution.tsrx';
export { exportsNavigation, EXPORTS_VIEW } from './navigation.ts';
export { ExportsView } from './ExportsView.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
