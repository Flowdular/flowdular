import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createSearchClientContribution as canonicalContribution } from './contribution.tsrx';

export { createSearchClientContribution } from './contribution.tsrx';
export type { SearchClientContributionOptions } from './contribution.tsrx';
export { SearchView } from './SearchView.tsrx';
export { SEARCH_VIEWS, workspaceRouteHref } from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
