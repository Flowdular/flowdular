import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { EXPORTS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'exports.navigation',
			label: 'Exports',
			href: '/exports',
			order: 45,
			permission: EXPORTS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(EXPORTS_PERMISSIONS),
} satisfies RegisteredModule;

export { EXPORTS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module that owns a list imports the identifier
   and the service type from here, builds its declaration with defineListExport
   from @flowdular/server, and registers it through the capability registry;
   nothing else in this module is meant to be imported by another. */
export { EXPORT_LISTS_CAPABILITY, EXPORT_LIST_LIMITS } from './domain/lists.ts';
export type { ExportLists } from './domain/lists.ts';

export {
	exportJobView,
	EXPORT_JOB_STATUSES,
	EXPORT_LIMITS,
	EXPORT_UNEXPECTED_FAILURE,
} from './domain/types.ts';
export type {
	ClaimedExportJob,
	ExportJob,
	ExportJobRouting,
	ExportJobStatus,
	ExportJobView,
	ExportRequester,
} from './domain/types.ts';
