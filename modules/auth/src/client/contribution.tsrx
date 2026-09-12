import { t, type ModuleClientContribution } from '@flowdular/client';
import { AUTH_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import { AuditView } from './audit/AuditView.tsrx';
import { IdentityProvidersView } from './providers/IdentityProvidersView.tsrx';
import { SettingsView } from './settings/SettingsView.tsrx';
import { SecurityView } from './security/SecurityView.tsrx';
import { ApiTokensView } from './tokens/ApiTokensView.tsrx';
import { AUTH_TRANSLATIONS } from './translations.ts';

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
		translations: AUTH_TRANSLATIONS,
		accountMenu: [
			{
				id: 'auth.account-menu.security',
				viewId: 'account-security',
				get label() {
					return t('auth.security.navigation.label');
				},
				get description() {
					return t('auth.security.navigation.description');
				},
				glyph: 'shield',
				scope: AUTH_SCOPES.sessionManage,
				order: 20,
			},
		],
		navigation: [
			{
				id: 'auth.navigation.api-tokens',
				viewId: 'api-tokens',
				group: 'Administration',
				get label() {
					return t('auth.navigation.tokens');
				},
				glyph: 'key',
				get description() {
					return t('auth.navigation.tokensDescription');
				},
				scope: AUTH_SCOPES.tokensRead,
				order: 30,
			},
			{
				id: 'auth.navigation.providers',
				viewId: 'identity-providers',
				group: 'Administration',
				get label() {
					return t('auth.navigation.providers');
				},
				glyph: 'shield',
				get description() {
					return t('auth.navigation.providersDescription');
				},
				scope: AUTH_SCOPES.providersRead,
				order: 35,
			},
			{
				id: 'auth.navigation.audit',
				viewId: 'audit',
				group: 'Administration',
				get label() {
					return t('auth.navigation.audit');
				},
				glyph: 'activity',
				get description() {
					return t('auth.navigation.auditDescription');
				},
				scope: AUTH_SCOPES.auditRead,
				order: 40,
			},
			{
				id: 'auth.navigation.settings',
				viewId: 'settings',
				group: 'Administration',
				get label() {
					return t('auth.navigation.settings');
				},
				glyph: 'settings',
				get description() {
					return t('auth.navigation.settingsDescription');
				},
				scope: PLATFORM_SCOPES.settingsRead,
				order: 50,
			},
		],
		views: [
			{
				id: 'account-security',
				render: () => <SecurityView csrfToken={options.csrfToken} />,
			},
			{
				id: 'api-tokens',
				render: () => <ApiTokensView csrfToken={options.csrfToken} />,
			},
			{
				id: 'identity-providers',
				render: () =>
					<IdentityProvidersView
						csrfToken={options.csrfToken}
						canManage={scopes.includes(AUTH_SCOPES.providersManage)}
					/>,
			},
			{ id: 'audit', render: () => <AuditView scopes={scopes} /> },
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
