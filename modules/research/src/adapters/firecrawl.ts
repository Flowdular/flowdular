import type {
	ResearchCaller,
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

export const FIRECRAWL_DEFINITION_KEY = 'research-firecrawl';
export const FIRECRAWL_INSTANCE_KEY = 'firecrawl';
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

const BODY_INPUT = {
	type: 'object',
	additionalProperties: false,
	required: ['body'],
	properties: { body: { type: 'object' } },
} as const;

export const FIRECRAWL_DEFINITION: ConnectorDefinitionShape = {
	key: FIRECRAWL_DEFINITION_KEY,
	moduleId: RESEARCH_MODULE_ID,
	label: 'Firecrawl',
	authKinds: ['bearer', 'none'],
	operations: [
		{
			key: 'search',
			label: 'Search',
			method: 'POST',
			path: '/v2/search',
			inputSchema: BODY_INPUT,
			outputSchema: {
				type: 'object',
				description: 'success and data.web, the search results.',
			},
		},
		{
			key: 'scrape',
			label: 'Scrape',
			method: 'POST',
			path: '/v2/scrape',
			inputSchema: BODY_INPUT,
			outputSchema: {
				type: 'object',
				description: 'success and data.markdown with data.metadata.',
			},
		},
	],
	defaultAllowedHosts: [],
};

const TBS: Readonly<Record<ResearchFreshness, string>> = {
	day: 'qdr:d',
	week: 'qdr:w',
	month: 'qdr:m',
	year: 'qdr:y',
};

export function firecrawlSearchInput(
	input: Pick<ResearchAdapterSearch, 'query' | 'limit' | 'freshness' | 'site'>,
	timeoutMs: number,
): Readonly<Record<string, unknown>> {
	return {
		body: {
			query: input.query,
			limit: input.limit,
			sources: [{ type: 'web' }],
			ignoreInvalidURLs: true,
			timeout: timeoutMs,
			...(input.freshness === null ? {} : { tbs: TBS[input.freshness] }),
			...(input.site === null ? {} : { includeDomains: [input.site] }),
		},
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/* v2 answers data.web; a v1 self-hosted deployment answers data as the list. */
export function mapFirecrawlResults(body: unknown): readonly ResearchResult[] {
	const data = record(body).data;
	const list = Array.isArray(data) ? data : record(data).web;
	if (!Array.isArray(list)) return [];
	return boundResults(
		list.map((entry) => {
			const value = record(entry);
			const metadata = record(value.metadata);
			return {
				url: value.url,
				title: value.title ?? metadata.title,
				snippet: value.description ?? metadata.description,
			};
		}),
	);
}

function text(value: unknown): string {
	if (typeof value === 'string') return value;
	return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

export interface FirecrawlPage {
	readonly title: string;
	readonly text: string;
	/** The address Firecrawl reports it read, which may differ after a redirect. */
	readonly url: string;
	readonly contentType: string;
}

export function mapFirecrawlPage(
	body: unknown,
	requested: string,
): FirecrawlPage {
	const value = record(body);
	const data = record(value.data);
	if (value.success === false || typeof data.markdown !== 'string') {
		throw new ResearchServiceError(
			'RESEARCH_CONNECTOR_FAILED',
			'Firecrawl answered without the page markdown.',
			502,
		);
	}
	const metadata = record(data.metadata);
	const status = Number(metadata.statusCode);
	if (Number.isInteger(status) && status >= 400) {
		throw new ResearchServiceError(
			'RESEARCH_FETCH_FAILED',
			`The page answered ${status}.`,
			502,
			{ retryable: status >= 500, health: false },
		);
	}
	return {
		title: text(metadata.title),
		text: data.markdown,
		url: text(metadata.url) || text(metadata.sourceURL) || requested,
		contentType: text(metadata.contentType),
	};
}

export interface FirecrawlAdapter extends ResearchAdapter {
	readonly key: 'firecrawl';
	page(input: {
		readonly tenantId: string;
		readonly url: string;
		readonly caller: ResearchCaller;
		readonly callerRef: string | null;
		readonly allowAgents: boolean;
		readonly timeoutMs: number;
		readonly signal: AbortSignal;
	}): Promise<FirecrawlPage>;
}

export function createFirecrawlAdapter(dependencies: {
	readonly calls: () => ConnectorCalls | undefined;
	readonly instances: () => ConnectorInstances | undefined;
}): FirecrawlAdapter {
	const call = async (
		tenantId: string,
		operation: 'search' | 'scrape',
		input: Readonly<Record<string, unknown>>,
		caller: ResearchCaller,
		callerRef: string | null,
		allowAgents: boolean,
		signal: AbortSignal | undefined,
	) => {
		const { instance, calls } = await moduleInstance(
			dependencies.instances,
			dependencies.calls,
			{ tenantId, caller, allowAgents },
			FIRECRAWL_INSTANCE_KEY,
			'Firecrawl',
		);
		const result = await calls.call({
			tenantId,
			instanceId: instance.id,
			operation,
			input,
			caller: connectorCaller(caller),
			...(callerRef === null ? {} : { callerRef }),
			...(signal ? { signal } : {}),
		});
		if (result.outcome === 'succeeded') return result.body;
		if (operation === 'scrape' && result.errorClass === 'response-too-large') {
			throw new ResearchServiceError(
				'RESEARCH_FETCH_TOO_LARGE',
				'The rendered page is larger than the connector response cap.',
				413,
			);
		}
		throw connectorCallFailure(result, 'Firecrawl');
	};

	return {
		key: 'firecrawl',
		async search(input) {
			return mapFirecrawlResults(
				await call(
					input.tenantId,
					'search',
					firecrawlSearchInput(
						input,
						input.settings.limits.firecrawl.timeoutMs,
					),
					input.caller,
					input.callerRef,
					input.settings.allowAgents,
					input.signal,
				),
			);
		},
		async page(input) {
			return mapFirecrawlPage(
				await call(
					input.tenantId,
					'scrape',
					{
						body: {
							url: input.url,
							formats: ['markdown'],
							onlyMainContent: true,
							timeout: input.timeoutMs,
						},
					},
					input.caller,
					input.callerRef,
					input.allowAgents,
					input.signal,
				),
				input.url,
			);
		},
	};
}
