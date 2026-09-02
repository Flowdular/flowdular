import { t, type ModuleClientContribution } from '@coreloom/client';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { PartiesDashboardWidget, PartiesView } from './PartiesView.tsrx';

export interface PartiesClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createPartiesClientContribution(
	options: PartiesClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'parties.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'parties.navigation.customers',
				viewId: 'customers',
				group: 'Operations',
				get label() {
					return t('parties.navigation.customers');
				},
				glyph: 'parties',
				get description() {
					return t('parties.navigation.customersDescription');
				},
				scope: PARTY_PERMISSIONS.read,
				order: 10,
			},
			{
				id: 'parties.navigation.suppliers',
				viewId: 'suppliers',
				group: 'Operations',
				get label() {
					return t('parties.navigation.suppliers');
				},
				glyph: 'parties',
				get description() {
					return t('parties.navigation.suppliersDescription');
				},
				scope: PARTY_PERMISSIONS.read,
				order: 15,
			},
		],
		views: [
			{
				id: 'customers',
				render: () =>
					<PartiesView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(PARTY_PERMISSIONS.manage)}
						kind="customer"
					/>,
			},
			{
				id: 'suppliers',
				render: () =>
					<PartiesView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(PARTY_PERMISSIONS.manage)}
						kind="supplier"
					/>,
			},
		],
		widgets: [
			{
				id: 'parties.dashboard.master-data',
				slot: 'dashboard.metrics',
				scope: PARTY_PERMISSIONS.read,
				order: 10,
				render: () => <PartiesDashboardWidget />,
			},
		],
	};
}
