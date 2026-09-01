import type { ModuleClientContribution } from '@coreloom/client';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
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
		navigation: [
			{
				id: 'users.navigation',
				viewId: 'users',
				group: 'Administration',
				label: 'Users',
				glyph: 'users',
				description: 'Accounts and access',
				scope: USER_PERMISSIONS.read,
				order: 5,
			},
			{
				id: 'users.roles.navigation',
				viewId: 'roles',
				group: 'Administration',
				label: 'Roles',
				glyph: 'shield',
				description: 'Permissions and access',
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
