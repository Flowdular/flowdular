import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { DIRECTORY_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'directory.navigation',
			label: 'SCIM tokens',
			href: '/directory-tokens',
			order: 70,
			permission: DIRECTORY_PERMISSIONS.read,
		},
	],
	permissions: Object.values(DIRECTORY_PERMISSIONS),
} satisfies RegisteredModule;

export { DIRECTORY_PERMISSIONS } from './acl/permissions.ts';
export {
	DIRECTORY_MODULE_ID,
	DIRECTORY_MODULE_SETTINGS,
	directoryDefaultRole,
	directoryPageSizeMax,
} from './settings.ts';
export { SCIM_SCHEMAS, ScimError } from './domain/scim.ts';
export {
	DIRECTORY_REASONS,
	PROVISIONING_OPERATIONS,
	PROVISIONING_OUTCOMES,
	SCIM_TOKEN_STATUSES,
} from './domain/types.ts';
export type {
	IssuedScimToken,
	ProvisioningEvent,
	ProvisioningEventQuery,
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimGroupMapping,
	ScimToken,
	ScimTokenStatus,
	ScimUserMapping,
} from './domain/types.ts';
export { DirectoryServiceError } from './services/service-error.ts';
