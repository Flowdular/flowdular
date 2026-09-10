import { t, type ModuleClientContribution } from '@flowdular/client';
import { SANDBOX_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { SandboxAccessView } from './SandboxAccessView.tsrx';

export interface SandboxClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createSandboxClientContribution(
	options: SandboxClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'sandbox.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'sandbox.navigation.access',
				viewId: 'sandbox',
				group: 'Development',
				get label() {
					return t('sandbox.navigation.sandbox');
				},
				glyph: 'flask',
				get description() {
					return t('sandbox.navigation.description');
				},
				scope: SANDBOX_PERMISSIONS.manage,
				order: 50,
			},
		],
		views: [
			{
				id: 'sandbox',
				render: () =>
					<SandboxAccessView
						csrfToken={options.csrfToken}
						canReadSessions={options.scopes.includes(
							SANDBOX_PERMISSIONS.sessionsRead,
						)}
					/>,
			},
		],
	};
}
