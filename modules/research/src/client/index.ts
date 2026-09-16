import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createResearchClientContribution as canonicalContribution } from './contribution.tsrx';

export { createResearchClientContribution } from './contribution.tsrx';
export { EvidenceDrawer } from './EvidenceDrawer.tsrx';
export { ResearchView } from './ResearchView.tsrx';
export {
	evidenceIdFromLocation,
	RESEARCH_VIEWS,
	researchNavigation,
} from './navigation.ts';
export {
	loadEvidence,
	loadEvidenceDetail,
	loadQueries,
	ResearchApiError,
	researchErrorMessage,
} from './api.ts';
export {
	adapterLabel,
	callerLabel,
	numberLabel,
	screenSurface,
	shortDigest,
	timestampLabel,
} from './presentation.ts';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	_context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution();
}
