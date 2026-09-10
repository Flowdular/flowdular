/* Mirror of .ai/references/catalog/src/client/index.ts: the canonical entry the
   generated composition imports as createClientContribution from
   <package>/client. */
export { createCustomerClientContribution } from './contribution.tsrx';
export type { CustomerClientContributionOptions } from './contribution.tsrx';
export {
	CustomerDashboardWidget,
	CustomerListView,
} from './CustomerListView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createCustomerClientContribution as canonicalContribution } from './contribution.tsrx';

export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
