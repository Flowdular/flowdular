export { createAutomationsRoutes } from '../api/endpoints.ts';
export {
	createAutomationsRuntime,
	automationsRuntimeOptionsFromEnvironment,
} from './runtime.ts';
export type {
	AutomationsRuntime,
	AutomationsRuntimeOptions,
} from './runtime.ts';
export {
	AUTOMATION_EXECUTION_CAPABILITY,
	createAutomationExecutionCapability,
} from './execution.ts';
export type {
	AutomationExecutionCapability,
	AutomationExecutionContext,
	AutomationScheduleRunAccepted,
	AutomationScheduleRunRequest,
} from './execution.ts';
export {
	AUTOMATION_TARGETS_CAPABILITY,
	createAutomationTargetRegistry,
} from './targets.ts';
export type {
	AutomationTargetAdapter,
	AutomationTargetAuthorizationContext,
	AutomationTargetInvocationContext,
	AutomationTargetInvocationRequest,
	AutomationTargetInvocationResult,
	AutomationTargetInvocationSource,
	AutomationTargetJsonValue,
	AutomationTargetReference,
	AutomationTargetRegistry,
} from './targets.ts';
export {
	AUTOMATIONS_MODULE_SETTINGS,
	automationsModuleSettingsFromEnvironment,
	automationsSchedulerPollMs,
} from '../settings.ts';
