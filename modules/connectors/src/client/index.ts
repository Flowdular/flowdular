import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createConnectorsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createConnectorsClientContribution } from './contribution.tsrx';
export type { ConnectorsClientContributionOptions } from './contribution.tsrx';
export { ConnectorsView } from './ConnectorsView.tsrx';
export { ConnectorCallsView } from './ConnectorCallsView.tsrx';
export { ConnectorForm } from './ConnectorForm.tsrx';
export { CONNECTORS_VIEWS, connectorsNavigation } from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
