import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { IMPORT_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'import.navigation',
			label: 'Imports',
			href: '/imports',
			order: 60,
			permission: IMPORT_PERMISSIONS.read,
		},
	],
	permissions: Object.values(IMPORT_PERMISSIONS),
} satisfies RegisteredModule;

export { IMPORT_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module that owns records imports the identifier
   and the types from here and registers its targets through the capability
   registry; nothing else in this module is meant to be imported by another. */
export {
	IMPORT_FIELD_TYPES,
	IMPORT_MODES,
	IMPORT_PORTS_CAPABILITY,
	IMPORT_PORT_LIMITS,
	importTargetId,
} from './domain/ports.ts';
export type {
	ImportField,
	ImportFieldType,
	ImportMode,
	ImportPort,
	ImportPorts,
	ImportRow,
	ImportValidateInput,
	ImportValidation,
	ImportWriteInput,
	ImportWriteOutcome,
} from './domain/ports.ts';

export {
	IMPORT_CSV_CONTENT_TYPE,
	IMPORT_JOB_STATUSES,
	IMPORT_LIMITS,
	IMPORT_MAX_CSV_BYTES,
	IMPORT_ROW_OUTCOMES,
} from './domain/types.ts';
export type {
	ClaimedImportJob,
	ImportJob,
	ImportJobRow,
	ImportJobStatus,
	ImportMapping,
	ImportRowOutcome,
} from './domain/types.ts';
