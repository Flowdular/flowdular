import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { CONNECTORS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'connectors.navigation',
			label: 'Connectors',
			href: '/connectors',
			order: 50,
			permission: CONNECTORS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(CONNECTORS_PERMISSIONS),
} satisfies RegisteredModule;

export { CONNECTORS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module shipping its own connector kind, and a
   caller invoking one, import the identifiers and types from here and resolve
   the implementations through the capability registry. */
export {
	CONNECTORS_DEFINITIONS_CAPABILITY,
	ConnectorDefinitionError,
} from './domain/definitions.ts';
export type { ConnectorDefinitionRegistry } from './domain/definitions.ts';
export { CONNECTORS_CALLS_CAPABILITY } from './domain/calls.ts';
export type {
	ConnectorCallCapability,
	ConnectorCallRequest,
	ConnectorCallResult,
	ConnectorJsonValue,
} from './domain/calls.ts';
export {
	HTTP_JSON_DEFINITION,
	HTTP_JSON_DEFINITION_KEY,
} from './domain/http-json.ts';

export {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_CALL_OUTCOMES,
	CONNECTOR_CALLERS,
	CONNECTOR_ERROR_CLASSES,
	CONNECTOR_INSTANCE_STATUSES,
	CONNECTOR_METHODS,
} from './domain/types.ts';
export type {
	ConnectorAuditEvent,
	ConnectorAuthKind,
	ConnectorCall,
	ConnectorCaller,
	ConnectorCallOutcome,
	ConnectorDefinition,
	ConnectorErrorClass,
	ConnectorInstance,
	ConnectorInstanceStatus,
	ConnectorOperation,
	CreateConnectorInstanceInput,
	UpdateConnectorInstanceInput,
} from './domain/types.ts';

export { ConnectorsServiceError } from './services/service-error.ts';
