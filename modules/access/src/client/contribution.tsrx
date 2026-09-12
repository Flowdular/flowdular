import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { ACCESS_PERMISSIONS } from '../acl/permissions.ts';
import { ActivityView } from './ActivityView.tsrx';
import { AttestationsView } from './AttestationsView.tsrx';
import { accessNavigation, ACCESS_VIEWS } from './navigation.ts';
import { ReviewView } from './ReviewView.tsrx';

export interface AccessClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createAccessClientContribution(
	options: AccessClientContributionOptions,
): ModuleClientContribution {
	/* The action is hidden without the scope; the server refuses it either way,
   so this is presentation and never the authorization. */
	const canAttest = options.scopes.includes(ACCESS_PERMISSIONS.manage);
	return {
		moduleId: 'access.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: accessNavigation,
		views: [
			{
				id: ACCESS_VIEWS.review,
				render: () =>
					<ReviewView csrfToken={options.csrfToken} canAttest={canAttest} />,
			},
			{
				id: ACCESS_VIEWS.activity,
				render: () => <ActivityView csrfToken={options.csrfToken} />,
			},
			{
				id: ACCESS_VIEWS.attestations,
				render: () => <AttestationsView csrfToken={options.csrfToken} />,
			},
		],
	};
}
