import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createAccessClientContribution as canonicalContribution } from './contribution.tsrx';

export { createAccessClientContribution } from './contribution.tsrx';
export type { AccessClientContributionOptions } from './contribution.tsrx';
export { ActivityView } from './ActivityView.tsrx';
export { AttestationsView } from './AttestationsView.tsrx';
export { ReviewView } from './ReviewView.tsrx';
export { accessNavigation, ACCESS_VIEWS } from './navigation.ts';
export {
	AccessApiError,
	accessErrorMessage,
	loadAttestations,
	loadChanges,
	loadReview,
	recordAttestation,
} from './api.ts';
export {
	categoryLabel,
	dateLabel,
	isoDaysBefore,
	memberTone,
	numberLabel,
	screenSurface,
	statusLabel,
	timestampLabel,
	todayIso,
} from './presentation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({
		csrfToken: context.csrfToken,
		scopes: context.scopes,
	});
}
