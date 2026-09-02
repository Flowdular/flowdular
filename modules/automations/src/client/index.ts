import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createAutomationsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createAutomationsClientContribution } from './contribution.tsrx';
export type { AutomationsClientContributionOptions } from './contribution.tsrx';
export { AutomationSchedulesView } from './AutomationSchedulesView.tsrx';
export { AutomationTriggersView } from './AutomationTriggersView.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
