import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { ADAPTERS_PERMISSIONS } from '../acl/permissions.ts';
import { DataAdaptersView } from './DataAdaptersView.tsrx';
import { adaptersNavigation, DATA_ADAPTERS_VIEW } from './navigation.ts';

export interface AdaptersClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createAdaptersClientContribution(
	options: AdaptersClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(ADAPTERS_PERMISSIONS.manage);
	return {
		moduleId: 'adapters.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: adaptersNavigation,
		views: [
			{
				id: DATA_ADAPTERS_VIEW,
				render: () =>
					<DataAdaptersView
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
		],
	};
}
