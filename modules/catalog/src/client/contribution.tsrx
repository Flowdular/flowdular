import type { ModuleClientContribution } from '@coreloom/client';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import { CatalogDashboardWidget, CatalogView } from './CatalogView.tsrx';

export interface CatalogClientContributionOptions {
	readonly csrfToken: string;
}

export function createCatalogClientContribution(
	options: CatalogClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'catalog.core',
		navigation: [
			{
				id: 'catalog.navigation',
				viewId: 'catalog',
				group: 'Operations',
				label: 'Catalog',
				glyph: 'catalog',
				description: 'Products and services',
				scope: CATALOG_PERMISSIONS.read,
				order: 20,
			},
		],
		views: [
			{
				id: 'catalog',
				render: () => <CatalogView csrfToken={options.csrfToken} />,
			},
		],
		widgets: [
			{
				id: 'catalog.dashboard.master-data',
				slot: 'dashboard.metrics',
				scope: CATALOG_PERMISSIONS.read,
				order: 20,
				render: () => <CatalogDashboardWidget />,
			},
		],
	};
}
