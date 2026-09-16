import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createAdaptersClientContribution as canonicalContribution } from './contribution.tsrx';

export { createAdaptersClientContribution } from './contribution.tsrx';
export type { AdaptersClientContributionOptions } from './contribution.tsrx';
export { DataAdaptersView } from './DataAdaptersView.tsrx';
export { adaptersNavigation, DATA_ADAPTERS_VIEW } from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
