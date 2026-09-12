import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { IMPORT_PERMISSIONS } from '../acl/permissions.ts';
import { ImportsView } from './ImportsView.tsrx';
import { importNavigation, IMPORTS_VIEW } from './navigation.ts';

export interface ImportClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createImportClientContribution(
	options: ImportClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(IMPORT_PERMISSIONS.manage);
	return {
		moduleId: 'import.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: importNavigation,
		views: [
			{
				id: IMPORTS_VIEW,
				render: () =>
					<ImportsView csrfToken={options.csrfToken} canManage={canManage} />,
			},
		],
	};
}
