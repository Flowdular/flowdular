import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { USER_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'users.navigation',
			label: 'Users',
			href: '/users',
			order: 5,
			permission: USER_PERMISSIONS.read,
		},
		{
			id: 'users.roles.navigation',
			label: 'Roles',
			href: '/roles',
			order: 10,
			permission: USER_PERMISSIONS.read,
		},
	],
	permissions: Object.values(USER_PERMISSIONS),
} satisfies RegisteredModule;

export { USER_PERMISSIONS } from './acl/permissions.ts';
export type { CreateUserInput } from './services/users-service.ts';
