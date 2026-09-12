import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { EXPORTS_PERMISSIONS } from '../acl/permissions.ts';
import { ExportsView } from './ExportsView.tsrx';
import { exportsNavigation, EXPORTS_VIEW } from './navigation.ts';

export interface ExportsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createExportsClientContribution(
	options: ExportsClientContributionOptions,
): ModuleClientContribution {
	/* The control is hidden without the scope; the server refuses a start either
   way, so this is presentation and never the authorization. */
	const canManage = options.scopes.includes(EXPORTS_PERMISSIONS.manage);
	return {
		moduleId: 'exports.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: exportsNavigation,
		views: [
			{
				id: EXPORTS_VIEW,
				render: () =>
					<ExportsView csrfToken={options.csrfToken} canManage={canManage} />,
			},
		],
	};
}
