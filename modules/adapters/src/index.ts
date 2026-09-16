import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { ADAPTERS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'adapters.navigation',
			label: 'Data adapters',
			href: '/data-adapters',
			order: 72,
			permission: ADAPTERS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(ADAPTERS_PERMISSIONS),
} satisfies RegisteredModule;

export { ADAPTERS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module that declares adapters in its spec
   imports the identifiers and types from here and registers them through the
   capability registry; nothing else in this module is meant to be imported by
   another. */
export {
	ADAPTER_DIRECTIONS,
	ADAPTER_IMPORT_MODES,
	ADAPTER_TRANSFORMS,
	ADAPTERS_SINKS_CAPABILITY,
	ADAPTERS_SOURCES_CAPABILITY,
} from './domain/registry.ts';
export type {
	AdapterDirection,
	AdapterImportMode,
	AdapterJson,
	AdapterJsonObject,
	AdapterMappingRule,
	AdapterPaging,
	AdapterRecordedCall,
	AdapterRecordedFixture,
	AdapterRegistration,
	AdapterRegistry,
	AdapterTransform,
} from './domain/registry.ts';
export { MAPPING_FORMATS } from './domain/mapping.ts';
export {
	ADAPTER_AUDIT_ACTIONS,
	ADAPTER_LIMITS,
	ADAPTER_ROW_OUTCOMES,
	ADAPTER_RUN_STATUSES,
	ADAPTER_RUN_TRIGGERS,
	ADAPTERS_MODULE_ID,
} from './domain/types.ts';
export type {
	AdapterBinding,
	AdapterRowOutcome,
	AdapterRunRow,
	AdapterRunStatus,
	AdapterRunTrigger,
	AdapterRunView,
} from './domain/types.ts';
