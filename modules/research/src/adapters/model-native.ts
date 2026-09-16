import type { ResearchResult } from '../domain/capability.ts';
import type { ResearchRepository } from '../services/repository.ts';
import { ResearchServiceError } from '../services/service-error.ts';
import type { ResearchAdapter } from './types.ts';

function unavailable(message: string): ResearchServiceError {
	return new ResearchServiceError('RESEARCH_ADAPTER_UNAVAILABLE', message, 409);
}

/**
 * The provider runs a model-native search itself through the native tool
 * research.web-search, and its citations are recorded as the run's query and
 * evidence when they arrive. This adapter reads that record back for the same
 * run and query, so the model can cite evidence ids; it never searches.
 */
export function createModelNativeAdapter(
	repository: ResearchRepository,
): ResearchAdapter {
	return {
		key: 'model-native',
		async search(input): Promise<readonly ResearchResult[]> {
			if (input.caller === 'member' || input.callerRef === null) {
				throw unavailable(
					'The model-native adapter answers inside an agent run only, through the native web search tool.',
				);
			}
			const evidence = await repository.nativeEvidence(
				input.tenantId,
				input.callerRef,
				input.query,
			);
			if (evidence === null) {
				throw unavailable(
					'No native web search for this query was reported in this run.',
				);
			}
			return evidence.slice(0, input.limit).map((entry) => ({
				url: entry.url,
				title: entry.title,
				snippet: entry.excerpt,
				source: new URL(entry.url).hostname,
				evidenceId: entry.id,
			}));
		},
	};
}
