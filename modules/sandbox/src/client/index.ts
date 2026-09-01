export { createSandboxClientContribution } from './contribution.tsrx';
export type { SandboxClientContributionOptions } from './contribution.tsrx';
export { SandboxAccessView } from './SandboxAccessView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createSandboxClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
