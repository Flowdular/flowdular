export { createExampleClientContribution } from './contribution.tsrx';
export type { ExampleClientContributionOptions } from './contribution.tsrx';
export { NotesView } from './NotesView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/sdk/client';
import { createExampleClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
