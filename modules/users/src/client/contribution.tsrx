import { t, type ModuleClientContribution } from '@flowdular/client';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { RolesView } from './RolesView.tsrx';
import {
	UsersDashboardWidget,
	UsersSetupStep,
	UsersView,
} from './UsersView.tsrx';

export interface UsersClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

const ROLES_READ = 'auth.roles.read';
const ROLES_MANAGE = 'auth.roles.manage';

export function createUsersClientContribution(
	options: UsersClientContributionOptions,
): ModuleClientContribution {
	const has = (scope: string) => options.scopes.includes(scope);
	return {
		moduleId: 'users.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'users.navigation',
				viewId: 'users',
				group: 'Administration',
				get label() {
					return t('users.navigation.users');
				},
				glyph: 'users',
				get description() {
					return t('users.navigation.usersDescription');
				},
				scope: USER_PERMISSIONS.read,
				order: 5,
			},
			{
				id: 'users.roles.navigation',
				viewId: 'roles',
				group: 'Administration',
				get label() {
					return t('users.navigation.roles');
				},
				glyph: 'shield',
				get description() {
					return t('users.navigation.rolesDescription');
				},
				scope: ROLES_READ,
				order: 10,
			},
		],
		views: [
			{
				id: 'users',
				render: () =>
					<UsersView
						csrfToken={options.csrfToken}
						canManage={has(USER_PERMISSIONS.manage)}
					/>,
			},
			{
				id: 'roles',
				render: () =>
					<RolesView
						csrfToken={options.csrfToken}
						canManage={has(ROLES_MANAGE)}
					/>,
			},
		],
		widgets: [
			{
				id: 'users.dashboard.access',
				slot: 'dashboard.metrics',
				scope: USER_PERMISSIONS.read,
				order: 30,
				render: () => <UsersDashboardWidget />,
			},
			{
				id: 'users.dashboard.setup',
				slot: 'dashboard.main',
				scope: USER_PERMISSIONS.manage,
				order: 30,
				render: () => <UsersSetupStep />,
			},
		],
	};
}
