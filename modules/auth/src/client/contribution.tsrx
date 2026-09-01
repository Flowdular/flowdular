import type { ModuleClientContribution } from '@coreloom/client';
import { AUTH_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import { AuditView } from './audit/AuditView.tsrx';
import { SettingsView } from './settings/SettingsView.tsrx';
import { ApiTokensView } from './tokens/ApiTokensView.tsrx';

export interface AuthClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes?: readonly string[];
}

export function createAuthClientContribution(
	options: AuthClientContributionOptions,
): ModuleClientContribution {
	const scopes = options.scopes ?? [];
	return {
		moduleId: 'auth.core',
		navigation: [
			{
				id: 'auth.navigation.api-tokens',
				viewId: 'api-tokens',
				group: 'Administration',
				label: 'API tokens',
				glyph: 'key',
				description: 'Machine credentials',
				scope: AUTH_SCOPES.tokensRead,
				order: 30,
			},
			{
				id: 'auth.navigation.audit',
				viewId: 'audit',
				group: 'Administration',
				label: 'Audit',
				glyph: 'activity',
				description: 'Sign-ins and changes',
				scope: AUTH_SCOPES.auditRead,
				order: 40,
			},
			{
				id: 'auth.navigation.settings',
				viewId: 'settings',
				group: 'Administration',
				label: 'Settings',
				glyph: 'modules',
				description: 'Workspace identity and defaults',
				scope: PLATFORM_SCOPES.settingsRead,
				order: 50,
			},
		],
		views: [
			{
				id: 'api-tokens',
				render: () => <ApiTokensView csrfToken={options.csrfToken} />,
			},
			{ id: 'audit', render: () => <AuditView /> },
			{
				id: 'settings',
				render: () =>
					<SettingsView
						csrfToken={options.csrfToken}
						canManage={scopes.includes(PLATFORM_SCOPES.settingsManage)}
					/>,
			},
		],
	};
}
