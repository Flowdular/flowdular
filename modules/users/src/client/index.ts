export { createUsersClientContribution } from './contribution.tsrx';
export type { UsersClientContributionOptions } from './contribution.tsrx';
export { RolesView } from './RolesView.tsrx';
export { UsersDashboardWidget, UsersView } from './UsersView.tsrx';
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@coreloom/client';
import { createUsersClientContribution as canonicalContribution } from './contribution.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
