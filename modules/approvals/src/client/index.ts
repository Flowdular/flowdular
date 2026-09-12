import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createApprovalsClientContribution as canonicalContribution } from './contribution.tsrx';

export { createApprovalsClientContribution } from './contribution.tsrx';
export type { ApprovalsClientContributionOptions } from './contribution.tsrx';
export { ApprovalRequestDrawer } from './ApprovalRequestDrawer.tsrx';
export { ApprovalsView } from './ApprovalsView.tsrx';
export { PendingCountWidget } from './PendingCountWidget.tsrx';
export {
	APPROVALS_PENDING_WIDGET,
	APPROVALS_VIEWS,
	approvalsNavigation,
	workspaceViewHref,
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
