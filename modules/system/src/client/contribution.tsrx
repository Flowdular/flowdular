import { t, type ModuleClientContribution } from '@flowdular/client';
import { SYSTEM_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { ApiDocsView } from './ApiDocsView.tsrx';
import { BrandingView } from './BrandingView.tsrx';
import { ModulesView } from './ModulesView.tsrx';
import './branding.css';

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
				section: 'platform',
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
			{
				id: 'system.navigation.branding',
				viewId: 'branding',
				group: 'Administration',
				section: 'platform',
				get label() {
					return t('system.navigation.branding');
				},
				glyph: 'sparkle',
				get description() {
					return t('system.navigation.brandingDescription');
				},
				scope: SYSTEM_PERMISSIONS.settingsRead,
				order: 62,
			},
			{
				id: 'system.navigation.api',
				viewId: 'api',
				group: 'Administration',
				section: 'platform',
				get label() {
					return t('system.navigation.api');
				},
				glyph: 'code',
				get description() {
					return t('system.navigation.apiDescription');
				},
				scope: SYSTEM_PERMISSIONS.modulesRead,
				order: 61,
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
			{ id: 'api', render: () => <ApiDocsView /> },
			{
				id: 'branding',
				render: () =>
					<BrandingView
						csrfToken={options.csrfToken}
						canManage={scopes.includes(SYSTEM_PERMISSIONS.settingsManage)}
					/>,
			},
		],
	};
}
