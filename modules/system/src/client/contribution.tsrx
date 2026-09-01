import type { ModuleClientContribution } from '@coreloom/client';
import { SYSTEM_PERMISSIONS } from '../acl/permissions.ts';
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
		navigation: [
			{
				id: 'system.navigation.modules',
				viewId: 'modules',
				group: 'Administration',
				label: 'Modules',
				glyph: 'modules',
				description: 'Installed modules, surfaces, and settings',
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
