import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createExpensesClientContribution as canonicalContribution } from './contribution.tsrx';

export { createExpensesClientContribution } from './contribution.tsrx';
export type { ExpensesClientContributionOptions } from './contribution.tsrx';
export { ExpensesDashboardWidget, ExpensesView } from './ExpensesView.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
