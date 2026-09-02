import { t, type ModuleClientContribution } from '@coreloom/client';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
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
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'expenses.navigation',
				viewId: 'expenses',
				group: 'Operations',
				get label() {
					return t('expenses.navigation.label');
				},
				glyph: 'file-text',
				get description() {
					return t('expenses.navigation.description');
				},
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
