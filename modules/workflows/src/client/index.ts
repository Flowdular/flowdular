import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createWorkflowsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createWorkflowsClientContribution } from './contribution.tsrx';
export type { WorkflowsClientContributionOptions } from './contribution.tsrx';
export { WorkflowsView } from './WorkflowsView.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
