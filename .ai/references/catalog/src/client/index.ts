export { createCatalogClientContribution } from './contribution.tsrx';
export type { CatalogClientContributionOptions } from './contribution.tsrx';
export { CatalogDashboardWidget, CatalogView } from './CatalogView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/sdk/client';
import { createCatalogClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
