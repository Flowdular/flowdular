import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { CONNECTORS_PERMISSIONS } from '../acl/permissions.ts';
import { ConnectorCallsView } from './ConnectorCallsView.tsrx';
import { ConnectorsView } from './ConnectorsView.tsrx';
import { CONNECTORS_VIEWS, connectorsNavigation } from './navigation.ts';

export interface ConnectorsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createConnectorsClientContribution(
	options: ConnectorsClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(CONNECTORS_PERMISSIONS.manage);
	return {
		moduleId: 'connectors.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: connectorsNavigation,
		views: [
			{
				id: CONNECTORS_VIEWS.instances,
				render: () =>
					<ConnectorsView
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
			{
				id: CONNECTORS_VIEWS.calls,
				render: () => <ConnectorCallsView csrfToken={options.csrfToken} />,
			},
		],
	};
}
