export { authorize } from './acl.ts';
export type { AccessDecision, Principal } from './acl.ts';
export { createPlatformAgentRegistry } from './agent-registry.ts';
export type {
	MutablePlatformAgentRegistry,
	PlatformAgentRegistry,
} from './agent-registry.ts';
export {
	agentActor,
	actorsEqual,
	MAX_ACTOR_ID_LENGTH,
	MAX_ACTOR_LABEL_LENGTH,
	normalizeActor,
	serviceActor,
	userActor,
} from './actor.ts';
export type {
	Actor,
	ActorKind,
	AgentActor,
	AgentActorSource,
	ServiceActor,
	ServiceActorSource,
	UserActor,
	UserActorSource,
} from './actor.ts';
export { createPlatformCapabilityRegistry } from './capability-registry.ts';
export type { PlatformCapabilityRegistry } from './capability-registry.ts';
export { RegistryError } from './errors.ts';
export {
	DEFAULT_HISTORY_PAGE,
	diffFields,
	MAX_HISTORY_PAGE,
	parseHistoryRequest,
} from './record-history.ts';
export type {
	FieldChange,
	HistoryEntry,
	HistoryPage,
	HistoryQuery,
	HistoryRequest,
	HistoryValue,
	HistoryWrite,
	RecordChanges,
	TrackedFields,
} from './record-history.ts';
export { createModuleRegistry } from './module-registry.ts';
export {
	assertSettingValue,
	createModuleSettingsRuntime,
	defineModuleSettings,
	ModuleSettingsError,
	PLATFORM_SETTINGS_TENANT,
} from './module-settings.ts';
export type {
	ModuleSettingChange,
	ModuleSettingDefinition,
	ModuleSettingEntry,
	ModuleSettingRecord,
	ModuleSettingScope,
	ModuleSettingsDeclaration,
	ModuleSettingsRuntime,
	ModuleSettingsRuntimeOptions,
	ModuleSettingsStore,
	ModuleSettingType,
	ModuleSettingValue,
} from './module-settings.ts';
export type { ModuleRegistry } from './module-registry.ts';
export { createPlatformToolRegistry } from './tool-registry.ts';
export type { PlatformToolRegistry } from './tool-registry.ts';
export {
	createPlatformVariableRegistry,
	platformVariableRegistry,
	PLATFORM_VARIABLES_CAPABILITY,
	VariableResolutionError,
} from './variable-registry.ts';
export type {
	PlatformVariableRegistry,
	VariableResolutionRequest,
	VariableSourceResolutionContext,
	VariableSourceResolver,
} from './variable-registry.ts';

export {
	PLATFORM_API_VERSION,
	assertModuleCompatibility,
	assertModuleDependency,
	satisfiesModuleVersion,
	compareModuleVersions,
} from './module-compatibility.ts';
