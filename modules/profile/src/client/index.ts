export { createProfileClientContribution } from './contribution.tsrx';
export type { ProfileClientContributionOptions } from './contribution.tsrx';
export { ProfileView } from './ProfileView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createProfileClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
