import type { ModuleClientContribution } from '@flowdular/sdk/client';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { CatalogDashboardWidget, CatalogView } from './CatalogView.tsrx';
import {
	catalogNavigationDescription,
	catalogNavigationLabel,
} from './navigation-copy.ts';

export interface CatalogClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createCatalogClientContribution(
	options: CatalogClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'catalog.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'catalog.navigation',
				viewId: 'catalog',
				group: 'Operations',
				/* The shell registers this contribution's bundles after the factory
   returns. Getters resolve copy only when the shell reads navigation,
   after registration, and again when the active locale changes. */
				get label() {
					return catalogNavigationLabel();
				},
				glyph: 'catalog',
				get description() {
					return catalogNavigationDescription();
				},
				scope: CATALOG_PERMISSIONS.read,
				order: 20,
			},
		],
		views: [
			{
				id: 'catalog',
				render: () =>
					<CatalogView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(CATALOG_PERMISSIONS.manage)}
					/>,
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
