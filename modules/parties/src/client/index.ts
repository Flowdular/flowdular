export { createPartiesClientContribution } from './contribution.tsrx';
export type { PartiesClientContributionOptions } from './contribution.tsrx';
export { PartiesDashboardWidget, PartiesView } from './PartiesView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createPartiesClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
