import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createMeteringClientContribution as canonicalContribution } from './contribution.tsrx';

export { createMeteringClientContribution } from './contribution.tsrx';
export type { MeteringClientContributionOptions } from './contribution.tsrx';
export { LimitsView } from './LimitsView.tsrx';
export { UsageSummaryWidget } from './UsageSummaryWidget.tsrx';
export { UsageView } from './UsageView.tsrx';
export {
	METERING_USAGE_WIDGET,
	METERING_VIEWS,
	meteringNavigation,
} from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
