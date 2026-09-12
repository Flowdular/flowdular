import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createReportsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createReportsClientContribution } from './contribution.tsrx';
export type { ReportsClientContributionOptions } from './contribution.tsrx';
export { ReportsView } from './ReportsView.tsrx';
export { ReportsSummaryWidget } from './ReportsSummaryWidget.tsrx';
export { REPORTS_VIEWS } from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
