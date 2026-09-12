export {
	authorize,
	authorizeRecord,
	createPolicyRegistry,
	definePolicy,
	MAX_POLICIES,
} from './acl.ts';
export type {
	AccessDecision,
	ApprovalRequirement,
	MutablePolicyRegistry,
	Policy,
	PolicyDecision,
	PolicyDefinition,
	PolicyEvaluationContext,
	PolicyRegistry,
	Principal,
} from './acl.ts';
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
export {
	createDataClassRegistry,
	DATA_CLASS_LIMITS,
} from './data-class-registry.ts';
export type {
	DataClassCountInput,
	DataClassDeclaration,
	DataClassErasureInput,
	DataClassErasureResult,
	DataClassExportInput,
	DataClassExportSink,
	DataClassExportSummary,
	DataClassModuleEntry,
	DataClassSubject,
	DataClassSweepInput,
	MutablePlatformDataClassRegistry,
	PlatformDataClassRegistry,
} from './data-class-registry.ts';
export { createPlatformCapabilityRegistry } from './capability-registry.ts';
export type {
	ModuleCapabilityDeclaration,
	PlatformCapabilityRegistry,
} from './capability-registry.ts';
export { RegistryError } from './errors.ts';
export {
	createKeyring,
	keyFingerprint,
	KeyringError,
	KEYRING_IV_BYTES,
	KEYRING_KEY_BYTES,
	KEYRING_MAX_PREVIOUS_KEYS,
	KEYRING_TAG_BYTES,
	parsePreviousKeys,
} from './keyring.ts';
export type {
	Keyring,
	KeyringErrorCode,
	KeyringOptions,
	SealedEnvelope,
	StoredEnvelope,
} from './keyring.ts';
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
export {
	capabilityProviders,
	createModuleRegistry,
} from './module-registry.ts';
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
	ModuleSettingKind,
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
	incrementModuleVersion,
	retargetModuleRange,
} from './module-compatibility.ts';
export type { ModuleVersionLevel } from './module-compatibility.ts';
