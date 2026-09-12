import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createDirectoryClientContribution as canonicalContribution } from './contribution.tsrx';

export { createDirectoryClientContribution } from './contribution.tsrx';
export type { DirectoryClientContributionOptions } from './contribution.tsrx';
export { directoryNavigation, DIRECTORY_VIEWS } from './navigation.ts';
export { GroupMappingsView } from './GroupMappingsView.tsrx';
export { ProvisioningLogView } from './ProvisioningLogView.tsrx';
export { ScimTokensView } from './ScimTokensView.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
