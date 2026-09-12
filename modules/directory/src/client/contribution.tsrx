import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { DIRECTORY_PERMISSIONS } from '../acl/permissions.ts';
import { GroupMappingsView } from './GroupMappingsView.tsrx';
import { directoryNavigation, DIRECTORY_VIEWS } from './navigation.ts';
import { ProvisioningLogView } from './ProvisioningLogView.tsrx';
import { ScimTokensView } from './ScimTokensView.tsrx';

export interface DirectoryClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createDirectoryClientContribution(
	options: DirectoryClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(DIRECTORY_PERMISSIONS.manage);
	return {
		moduleId: 'directory.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: directoryNavigation,
		views: [
			{
				id: DIRECTORY_VIEWS.tokens,
				render: () =>
					<ScimTokensView
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
			{
				id: DIRECTORY_VIEWS.groups,
				render: () =>
					<GroupMappingsView
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
			{
				id: DIRECTORY_VIEWS.log,
				render: () => <ProvisioningLogView />,
			},
		],
	};
}
