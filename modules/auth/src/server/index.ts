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
	createMfaEnrolmentMiddleware,
	guardMfaSettings,
	mfaEnrolmentSatisfied,
	MFA_ENROLMENT_REQUIRED,
	MFA_KEY_REQUIRED,
} from './mfa-enforcement.ts';
export type { MfaEnrolmentGate } from './mfa-enforcement.ts';
export { createOidcVerifier } from './oidc.ts';
export type { OidcVerifier, VerifiedIdToken } from './oidc.ts';
export {
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
} from '@flowdular/kernel';
export { AuthServiceError } from '../services/auth-service-error.ts';
/* The platform mail port opens its SMTP connection with this factory: auth.core
   is the module that declares the mail client dependency. */
export { nodemailerSmtpTransport } from '../services/mail-smtp.ts';
export {
	AUDIT_ACTIONS,
	AUDIT_ACTION_LIST,
	TENANT_MEMBER_LOOKUP_LIMIT,
	TENANT_MEMBER_SEARCH_LIMIT,
	TENANT_MEMBER_SEARCH_TERM_LENGTH,
} from '../services/auth-service.ts';
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
