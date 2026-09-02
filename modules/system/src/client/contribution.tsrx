import { t, type ModuleClientContribution } from '@coreloom/client';
import { SYSTEM_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { ModulesView } from './ModulesView.tsrx';

export interface SystemClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes?: readonly string[];
}

export function createSystemClientContribution(
	options: SystemClientContributionOptions,
): ModuleClientContribution {
	const scopes = options.scopes ?? [];
	return {
		moduleId: 'system.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'system.navigation.modules',
				viewId: 'modules',
				group: 'Administration',
				get label() {
					return t('system.navigation.modules');
				},
				glyph: 'modules',
				get description() {
					return t('system.navigation.modulesDescription');
				},
				scope: SYSTEM_PERMISSIONS.modulesRead,
				order: 60,
			},
		],
		views: [
			{
				id: 'modules',
				render: () =>
					<ModulesView
						csrfToken={options.csrfToken}
						canManageSettings={scopes.includes(
							SYSTEM_PERMISSIONS.settingsManage,
						)}
					/>,
			},
		],
	};
}
