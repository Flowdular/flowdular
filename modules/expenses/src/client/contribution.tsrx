import type { ModuleClientContribution } from '@coreloom/client';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import { ExpensesDashboardWidget, ExpensesView } from './ExpensesView.tsrx';

export interface ExpensesClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createExpensesClientContribution(
	options: ExpensesClientContributionOptions,
): ModuleClientContribution {
	const canRead = options.scopes.includes(EXPENSES_PERMISSIONS.read);
	const canManage = options.scopes.includes(EXPENSES_PERMISSIONS.manage);
	const canApprove = options.scopes.includes(EXPENSES_PERMISSIONS.approve);
	return {
		moduleId: 'expenses.core',
		navigation: [
			{
				id: 'expenses.navigation',
				viewId: 'expenses',
				group: 'Operations',
				label: 'Expense Claims',
				glyph: 'file-text',
				description: 'Create, submit, and review employee expense claims.',
				scope: EXPENSES_PERMISSIONS.read,
				order: 50,
			},
		],
		views: [
			{
				id: 'expenses',
				render: () =>
					<ExpensesView
						csrfToken={options.csrfToken}
						canRead={canRead}
						canManage={canManage}
						canApprove={canApprove}
					/>,
			},
		],
		widgets: [
			{
				id: 'expenses.dashboard.awaiting-approval',
				slot: 'dashboard.metrics',
				scope: EXPENSES_PERMISSIONS.approve,
				order: 30,
				render: () => <ExpensesDashboardWidget />,
			},
		],
	};
}
