import type {
	ResearchFreshness,
	ResearchResult,
} from '../domain/capability.ts';
import { RESEARCH_MODULE_ID } from '../domain/types.ts';
import type {
	ConnectorCalls,
	ConnectorDefinitionShape,
	ConnectorInstances,
} from '../services/capabilities.ts';
import { boundResults } from '../services/results.ts';
import { ResearchServiceError } from '../services/service-error.ts';
import {
	connectorCaller,
	connectorCallFailure,
	moduleInstance,
} from './connector-failure.ts';
import type { ResearchAdapter, ResearchAdapterSearch } from './types.ts';

export const SEARXNG_DEFINITION_KEY = 'research-searxng';
export const SEARXNG_INSTANCE_KEY = 'searxng';

export const SEARXNG_DEFINITION: ConnectorDefinitionShape = {
	key: SEARXNG_DEFINITION_KEY,
	moduleId: RESEARCH_MODULE_ID,
	label: 'SearXNG search',
	authKinds: ['none', 'bearer', 'api-key'],
	operations: [
		{
			key: 'search',
			label: 'Search',
			method: 'GET',
			path: '/search',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['query'],
				properties: {
					query: {
						type: 'object',
						description:
							'q, format json, pageno, categories and an optional time_range.',
					},
				},
			},
			outputSchema: {
				type: 'object',
				description: 'The SearXNG JSON answer with its results list.',
			},
		},
	],
	defaultAllowedHosts: [],
};

/* SearXNG documents day, month and year; a week asks for the month and the
   service's freshness filter drops what is older. */
const TIME_RANGE: Readonly<Record<ResearchFreshness, string>> = {
	day: 'day',
	week: 'month',
	month: 'month',
	year: 'year',
};

export function searxngInput(
	input: Pick<ResearchAdapterSearch, 'query' | 'freshness' | 'site'>,
): Readonly<Record<string, unknown>> {
	return {
		query: {
			q:
				input.site === null ? input.query : `${input.query} site:${input.site}`,
			format: 'json',
			pageno: 1,
			categories: 'general',
			...(input.freshness === null
				? {}
				: { time_range: TIME_RANGE[input.freshness] }),
		},
	};
}

export function mapSearxngResults(body: unknown): readonly ResearchResult[] {
	const results = (body as { results?: unknown } | null)?.results;
	if (!Array.isArray(results)) return [];
	return boundResults(
		results.map((entry) => {
			const value = (entry ?? {}) as Record<string, unknown>;
			return {
				url: value.url,
				title: value.title,
				snippet: value.content,
				publishedAt: value.publishedDate,
				source: value.engine,
			};
		}),
	);
}

export function searxngJsonDisabled(): ResearchServiceError {
	return new ResearchServiceError(
		'RESEARCH_SEARXNG_JSON_DISABLED',
		'The SearXNG instance answered 403 to format=json: json is missing from search.formats in its settings.yml, or a proxy in front of it refused the credential.',
		502,
	);
}

export function createSearxngAdapter(dependencies: {
	readonly calls: () => ConnectorCalls | undefined;
	readonly instances: () => ConnectorInstances | undefined;
}): ResearchAdapter {
	return {
		key: 'searxng',
		async search(input) {
			const { instance, calls } = await moduleInstance(
				dependencies.instances,
				dependencies.calls,
				{
					tenantId: input.tenantId,
					caller: input.caller,
					allowAgents: input.settings.allowAgents,
				},
				SEARXNG_INSTANCE_KEY,
				'SearXNG',
			);
			const result = await calls.call({
				tenantId: input.tenantId,
				instanceId: instance.id,
				operation: 'search',
				input: searxngInput(input),
				caller: connectorCaller(input.caller),
				...(input.callerRef === null ? {} : { callerRef: input.callerRef }),
				...(input.signal ? { signal: input.signal } : {}),
			});
			if (result.outcome !== 'succeeded') {
				/* SearXNG answers 403 for a format its settings.yml does not list. */
				if (result.status === 403) throw searxngJsonDisabled();
				throw connectorCallFailure(result, 'SearXNG');
			}
			return mapSearxngResults(result.body);
		},
	};
}
