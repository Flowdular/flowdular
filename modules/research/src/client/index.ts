import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createResearchClientContribution as canonicalContribution } from './contribution.tsrx';

export { createResearchClientContribution } from './contribution.tsrx';
export type { ResearchClientContributionOptions } from './contribution.tsrx';
export { AdapterDrawer } from './AdapterDrawer.tsrx';
export { AdaptersPanel } from './AdaptersPanel.tsrx';
export { EvidenceDrawer } from './EvidenceDrawer.tsrx';
export { QueryAttemptsDrawer } from './QueryAttemptsDrawer.tsrx';
export { ResearchView } from './ResearchView.tsrx';
export {
	evidenceIdFromLocation,
	RESEARCH_VIEWS,
	researchNavigation,
} from './navigation.ts';
export {
	configureAdapter,
	loadAdapters,
	loadEvidence,
	loadEvidenceDetail,
	loadQueries,
	loadQueryAttempts,
	ResearchApiError,
	researchErrorMessage,
	saveChainSettings,
	testAdapter,
} from './api.ts';
export {
	adapterLabel,
	adapterStatusLabel,
	adapterStatusTone,
	attemptOutcomeLabel,
	attemptOutcomeTone,
	callerLabel,
	durationLabel,
	errorCodeLabel,
	numberLabel,
	screenSurface,
	shortDigest,
	timestampLabel,
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
