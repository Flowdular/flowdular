export { AuthenticationCore } from './AuthenticationCore.tsrx';
export type {
	AuthenticationControls,
	AuthenticationCoreProps,
} from './AuthenticationCore.tsrx';
export {
	authPathForScreen,
	authScreenFromUrl,
	canonicalAuthLocation,
	createAuthClientState,
	isAuthRouteUrl,
} from './state.ts';
export type { AuthClientState, AuthClientStatus, AuthScreen } from './state.ts';
export { createAuthClientContribution } from './contribution.tsrx';
export type { AuthClientContributionOptions } from './contribution.tsrx';
export { ApiTokensView } from './tokens/ApiTokensView.tsrx';
export { SecurityView } from './security/SecurityView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createAuthClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
