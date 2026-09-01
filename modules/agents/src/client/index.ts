export { AgentPlaygroundView } from './AgentPlaygroundView.tsrx';
export { AgentProvidersView } from './AgentProvidersView.tsrx';
export { AgentRunsView } from './AgentRunsView.tsrx';
export { AgentsView } from './AgentsView.tsrx';
export { createAgentClientContribution } from './contribution.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createAgentClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
