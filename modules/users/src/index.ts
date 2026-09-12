import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
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
export { MEMBER_EXPORT_LIST_ID } from './domain/lists.ts';
export { createMemberListExport } from './services/member-export.ts';
export {
	createMemberImportPort,
	MEMBER_IMPORT_PORT_KEY,
} from './services/member-import.ts';
export {
	createMemberSearchProvider,
	MEMBER_SEARCH_PROVIDER_KEY,
	MEMBER_SEARCH_SCAN_LIMIT,
} from './services/member-search.ts';
