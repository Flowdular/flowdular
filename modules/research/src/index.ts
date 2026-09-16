import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { RESEARCH_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'research.navigation',
			label: 'Research',
			href: '/research',
			order: 75,
			permission: RESEARCH_PERMISSIONS.read,
		},
	],
	permissions: Object.values(RESEARCH_PERMISSIONS),
} satisfies RegisteredModule;

export { RESEARCH_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module that searches, reads a page or cites
   evidence imports the identifiers and types from here and resolves the
   implementations through the capability registry. */
export {
	RESEARCH_CALLERS,
	RESEARCH_EVIDENCE_CAPABILITY,
	RESEARCH_FETCH_CAPABILITY,
	RESEARCH_FRESHNESS,
	RESEARCH_SEARCH_CAPABILITY,
} from './domain/capability.ts';
export type {
	EvidenceEntry,
	ResearchCaller,
	ResearchEvidence,
	ResearchFetch,
	ResearchFetchInput,
	ResearchFetchResult,
	ResearchFreshness,
	ResearchResult,
	ResearchSearch,
	ResearchSearchInput,
} from './domain/capability.ts';
export {
	RESEARCH_ADAPTERS,
	RESEARCH_LIMITS,
	RESEARCH_MODULE_ID,
	RESEARCH_QUERIES_METER,
} from './domain/types.ts';
export type {
	ResearchAdapterKey,
	ResearchEvidenceDetail,
	ResearchEvidenceLink,
	ResearchFixtures,
	ResearchQueryRecord,
	ResearchSettings,
} from './domain/types.ts';
export { ResearchServiceError } from './services/service-error.ts';
