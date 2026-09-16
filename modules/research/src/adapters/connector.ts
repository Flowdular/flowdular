import type { ResearchResult } from '../domain/capability.ts';
import type { ConnectorCalls } from '../services/capabilities.ts';
import { boundResults } from '../services/results.ts';
import { ResearchServiceError } from '../services/service-error.ts';
import { connectorCaller, connectorCallFailure } from './connector-failure.ts';
import type { ResearchAdapter } from './types.ts';

/**
 * The declared shape a search connector answers: a list at the top level or
 * under one of `list`, and per entry the first field of each name that is
 * present. Anything else maps to no result rather than a guess.
 */
export const CONNECTOR_RESULT_MAPPING = {
	list: ['results', 'items', 'data'],
	url: ['url', 'link'],
	title: ['title', 'name'],
	snippet: ['snippet', 'description', 'summary'],
	publishedAt: ['publishedAt', 'published_at', 'date'],
	source: ['source', 'displayUrl'],
} as const;

function first(
	entry: Readonly<Record<string, unknown>>,
	names: readonly string[],
): unknown {
	for (const name of names) {
		if (entry[name] !== undefined && entry[name] !== null) return entry[name];
	}
	return undefined;
}

export function mapConnectorResults(body: unknown): readonly ResearchResult[] {
	let list: unknown = body;
	if (!Array.isArray(body) && body && typeof body === 'object') {
		list = first(
			body as Record<string, unknown>,
			CONNECTOR_RESULT_MAPPING.list,
		);
	}
	if (!Array.isArray(list)) return [];
	return boundResults(
		list.map((entry) => {
			const value = (entry ?? {}) as Record<string, unknown>;
			return {
				url: first(value, CONNECTOR_RESULT_MAPPING.url),
				title: first(value, CONNECTOR_RESULT_MAPPING.title),
				snippet: first(value, CONNECTOR_RESULT_MAPPING.snippet),
				publishedAt: first(value, CONNECTOR_RESULT_MAPPING.publishedAt),
				source: first(value, CONNECTOR_RESULT_MAPPING.source),
			};
		}),
	);
}

/**
 * Calls the instance the workspace named. A member search is sent as a test
 * call: the owner naming the instance in the research settings is the consent,
 * while agent and workflow searches keep their own caller kinds and the
 * consent flags connectors.core holds for them.
 */
export function createConnectorAdapter(
	calls: () => ConnectorCalls | undefined,
): ResearchAdapter {
	return {
		key: 'connector',
		async search(input) {
			const instanceId = input.settings.connectorInstanceId.trim();
			const capability = calls();
			if (instanceId === '' || !capability) {
				throw new ResearchServiceError(
					'RESEARCH_ADAPTER_UNAVAILABLE',
					instanceId === ''
						? 'No connector instance is configured for research.'
						: 'connectors.core is not composed in this deployment.',
					409,
				);
			}
			const result = await capability.call({
				tenantId: input.tenantId,
				instanceId,
				operation: 'search',
				input: { q: input.query, limit: input.limit },
				caller: connectorCaller(input.caller),
				...(input.callerRef === null ? {} : { callerRef: input.callerRef }),
				...(input.signal ? { signal: input.signal } : {}),
			});
			if (result.outcome !== 'succeeded') {
				throw connectorCallFailure(result, 'search connector');
			}
			return mapConnectorResults(result.body);
		},
	};
}
