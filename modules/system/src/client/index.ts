import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createSystemClientContribution } from './contribution.tsrx';

export { createSystemClientContribution } from './contribution.tsrx';
export type { SystemClientContributionOptions } from './contribution.tsrx';
export { loadSystemOverview } from './overview-api.ts';
export type {
	OverviewActivityPoint,
	OverviewModulePoint,
	SystemOverviewPayload,
} from './overview-api.ts';
export { ModulesView } from './ModulesView.tsrx';
export { ModuleSettingsSection } from './ModuleSettingsSection.tsrx';
export { FlagsPanel } from './FlagsPanel.tsrx';
export { flagCount, flagGroups } from './flags.ts';
export type { FlagGroup } from './flags.ts';
export {
	AUDIT_VIEW_ID,
	FLAG_AUDIT_ACTION,
	SYSTEM_VIEWS,
} from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return createSystemClientContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
