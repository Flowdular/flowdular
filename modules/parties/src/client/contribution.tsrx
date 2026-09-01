import type { ModuleClientContribution } from '@coreloom/client';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import { PartiesDashboardWidget, PartiesView } from './PartiesView.tsrx';

export interface PartiesClientContributionOptions {
	readonly csrfToken: string;
}

export function createPartiesClientContribution(
	options: PartiesClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'parties.core',
		navigation: [
			{
				id: 'parties.navigation',
				viewId: 'parties',
				group: 'Operations',
				label: 'Customers & suppliers',
				glyph: 'parties',
				description: 'Business party records',
				scope: PARTY_PERMISSIONS.read,
				order: 10,
			},
		],
		views: [
			{
				id: 'parties',
				render: () => <PartiesView csrfToken={options.csrfToken} />,
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
