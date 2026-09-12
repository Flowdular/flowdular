import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createAuditClientContribution as canonicalContribution } from './contribution.tsrx';

export { createAuditClientContribution } from './contribution.tsrx';
export type { AuditClientContributionOptions } from './contribution.tsrx';
export { DataClassesView } from './DataClassesView.tsrx';
export { ExportsView } from './ExportsView.tsrx';
export { HoldsView } from './HoldsView.tsrx';
export { SweepsView } from './SweepsView.tsrx';
export { auditNavigation, AUDIT_VIEWS } from './navigation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
