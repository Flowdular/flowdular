export { actorFromContext } from './actor.ts';
export { createAuthRoutes } from './endpoints.ts';
export type {
	PlatformServerComposition,
	PlatformServerContext,
} from './composition.ts';
export {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	createModuleSettingsRuntime,
} from './runtime.ts';
export type {
	AuthModuleSettingsRuntime,
	AuthRuntime,
	AuthRuntimeEnvironmentOptions,
	AuthRuntimeOptions,
} from './runtime.ts';
export { sessionMutationDenial } from './session-security.ts';
export {
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
} from '@flowdular/kernel';
export { AuthServiceError } from '../services/auth-service-error.ts';
export { AUDIT_ACTIONS, AUDIT_ACTION_LIST } from '../services/auth-service.ts';
export {
	AUTH_PRINCIPAL_STATE_KEY,
	AUTH_SESSION_STATE_KEY,
	AUTH_TOKEN_PRINCIPAL_STATE_KEY,
	createAuthenticationMiddleware,
	isTokenPrincipal,
	endpointIdentityFromContext,
	principalFromContext,
	requireAuthentication,
	requireScopes,
	sessionFromContext,
} from '../middleware/authentication.ts';
