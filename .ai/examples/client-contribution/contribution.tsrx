/* Mirror of .ai/references/catalog/src/client/contribution.tsrx. In a module this file
   is src/client/contribution.tsrx, the permissions come from
   src/acl/permissions.ts, and the views from sibling .tsrx files. */
import type { ModuleClientContribution } from '@flowdular/client';
import { CUSTOMER_PERMISSIONS } from './permissions.ts';
import {
	CustomerDashboardWidget,
	CustomerListView,
} from './CustomerListView.tsrx';

export interface CustomerClientContributionOptions {
	readonly csrfToken: string;
}

export function createCustomerClientContribution(
	options: CustomerClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'customers.core',
		navigation: [
			{
				id: 'customers.navigation',
				viewId: 'customers',
				group: 'Operations',
				label: 'Customers',
				glyph: 'parties',
				description: 'Customer master data',
				scope: CUSTOMER_PERMISSIONS.read,
				order: 30,
			},
		],
		views: [
			{
				id: 'customers',
				render: () => <CustomerListView csrfToken={options.csrfToken} />,
			},
		],
		widgets: [
			{
				id: 'customers.dashboard.summary',
				slot: 'dashboard.metrics',
				scope: CUSTOMER_PERMISSIONS.read,
				order: 30,
				render: () => <CustomerDashboardWidget />,
			},
		],
	};
}
