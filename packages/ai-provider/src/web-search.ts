import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { APICallError, type LanguageModelMiddleware, type Tool } from 'ai';
import type { AiProviderKind } from './catalog.ts';

export const WEB_SEARCH_LIMITS = {
	defaultMaxUses: 5,
	maxUses: 16,
} as const;

/** Why a provider that has a web search tool did not run it for this request. */
export const WEB_SEARCH_DISABLED = 'PROVIDER_WEB_SEARCH_DISABLED';

/** One result a provider-executed web search returned or cited. */
export interface WebSearchResult {
	readonly url: string;
	readonly title: string;
	readonly snippet: string;
	readonly publishedAt?: string;
	/** The provider kind that ran the search. */
	readonly source: string;
}

export interface WebSearchReport {
	readonly query: string | null;
	readonly results: readonly WebSearchResult[];
}

export interface WebSearchPassThrough {
	readonly tool: Tool;
	readonly providerOptions?: Readonly<
		Record<string, Readonly<Record<string, number>>>
	>;
}

function maxUses(config: Readonly<Record<string, unknown>>): number {
	const value = config.maxUses;
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, WEB_SEARCH_LIMITS.maxUses)
		: WEB_SEARCH_LIMITS.defaultMaxUses;
}

function domains(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === 'string')
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
}

/* Anthropic refuses a request that names both lists, so an allow list is sent
   alone and a block list only when there is no allow list. */
function domainFilter(config: Readonly<Record<string, unknown>>): {
	readonly allowedDomains?: string[];
	readonly blockedDomains?: string[];
} {
	const allowed = domains(config.allowedDomains);
	if (allowed.length > 0) return { allowedDomains: allowed };
	const blocked = domains(config.blockedDomains);
	return blocked.length > 0 ? { blockedDomains: blocked } : {};
}

/**
 * The provider's own web search tool configured from a native tool's config
 * (`maxUses`, `allowedDomains`, `blockedDomains`), or null for a provider kind
 * without one.
 */
export function webSearchPassThrough(
	kind: AiProviderKind,
	config: Readonly<Record<string, unknown>>,
): WebSearchPassThrough | null {
	const filter = domainFilter(config);
	switch (kind) {
		case 'anthropic':
			return {
				tool: anthropic.tools.webSearch_20250305({
					maxUses: maxUses(config),
					...filter,
				}),
			};
		case 'openai':
			return {
				tool: openai.tools.webSearch(
					Object.keys(filter).length > 0 ? { filters: filter } : {},
				),
				providerOptions: { openai: { maxToolCalls: maxUses(config) } },
			};
		default:
			return null;
	}
}

/**
 * The reason code when a provider refused a request because of its web search
 * tool, else null. Only a 400 or 403 whose error body is a request or
 * permission error naming web search counts, so an unrelated 400 still fails.
 */
export function webSearchRefusal(error: unknown): string | null {
	if (
		!APICallError.isInstance(error) ||
		(error.statusCode !== 400 && error.statusCode !== 403)
	) {
		return null;
	}
	let body: unknown = error.data;
	try {
		body = JSON.parse(error.responseBody ?? '');
	} catch {
		/* The SDK's parsed error data stands in for an unreadable body. */
	}
	const detail = objectOf(objectOf(body).error);
	if (
		detail.type != null &&
		detail.type !== 'invalid_request_error' &&
		detail.type !== 'permission_error'
	) {
		return null;
	}
	return typeof detail.message === 'string' &&
		/web[\s_-]?search/i.test(detail.message)
		? WEB_SEARCH_DISABLED
		: null;
}

type ModelStream = Awaited<
	ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>
>['stream'];
type ModelStreamPart =
	ModelStream extends ReadableStream<infer Part> ? Part : never;

interface PendingSearch {
	query: string | null;
	results: { url: string; title: string; publishedAt?: string }[];
}

function objectOf(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function textOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined;
}

function callQuery(input: string): string | null {
	try {
		return textOf(objectOf(JSON.parse(input)).query) ?? null;
	} catch {
		return null;
	}
}

/* Anthropic answers a list of results and takes the query from the call;
   OpenAI answers the action it took, with its queries and the source URLs,
   and opening or reading within a page is not a search. */
function searchOf(
	kind: AiProviderKind,
	result: unknown,
	callQueryText: string | null,
): PendingSearch | null {
	if (kind === 'anthropic') {
		return {
			query: callQueryText,
			results: (Array.isArray(result) ? result : []).flatMap((entry) => {
				const value = objectOf(entry);
				const url = textOf(value.url);
				const publishedAt = textOf(value.pageAge);
				return url
					? [
							{
								url,
								title: textOf(value.title) ?? '',
								...(publishedAt ? { publishedAt } : {}),
							},
						]
					: [];
			}),
		};
	}
	const value = objectOf(result);
	const action = objectOf(value.action);
	if (action.type !== undefined && action.type !== 'search') return null;
	const queries = Array.isArray(action.queries) ? action.queries : [];
	return {
		query: textOf(queries[0]) ?? textOf(action.query) ?? callQueryText,
		results: (Array.isArray(value.sources) ? value.sources : []).flatMap(
			(entry) => {
				const source = objectOf(entry);
				const url = source.type === 'url' ? textOf(source.url) : undefined;
				return url ? [{ url, title: '' }] : [];
			},
		),
	};
}

export interface WebSearchReporterOptions {
	readonly kind: AiProviderKind;
	/** The key the pass-through tool has in the tool set. */
	readonly toolName: string;
	/** Reports for one model run; the overflow joins the last one allowed. */
	readonly maxReports: number;
	report(report: WebSearchReport): Promise<void>;
	/** Called once when the provider refused the tool; the run goes on without it. */
	unsupported(reason: string): Promise<void>;
}

/**
 * Turns the provider-executed searches of a streamed model call into reports,
 * with the titles and quoted text of the call's citations. The reports are
 * awaited before the call's stream ends, and the SDK runs the tools a model
 * called only after that, so such a tool can read back what a search recorded.
 */
export function webSearchReporter(
	options: WebSearchReporterOptions,
): LanguageModelMiddleware {
	let reported = 0;
	let refused = false;
	return {
		wrapStream: async ({ doStream, params, model }) => {
			/* A refused tool is left out of the retried call and of every later
			   call of the run, together with OpenAI's maxToolCalls, set for it. */
			const withoutTool = () => {
				const { tools = [], providerOptions = {} } = params;
				const { maxToolCalls: _, ...openai } = providerOptions.openai ?? {};
				return model.doStream({
					...params,
					tools: tools.filter(
						(tool) =>
							!(tool.type === 'provider' && tool.name === options.toolName),
					),
					providerOptions: {
						...providerOptions,
						...(providerOptions.openai ? { openai } : {}),
					},
				});
			};
			let answer: Awaited<ReturnType<typeof doStream>>;
			if (refused) {
				answer = await withoutTool();
			} else {
				try {
					answer = await doStream();
				} catch (error) {
					const reason = webSearchRefusal(error);
					if (reason === null) throw error;
					refused = true;
					await options.unsupported(reason);
					answer = await withoutTool();
				}
			}
			const { stream, ...rest } = answer;
			const calls = new Map<string, string | null>();
			const pending: PendingSearch[] = [];
			const citations = new Map<
				string,
				{ title: string | undefined; snippet: string | undefined }
			>();
			const flush = async (): Promise<void> => {
				const searches = pending.splice(0);
				const cited = new Map(citations);
				citations.clear();
				const remaining = options.maxReports - reported;
				if (searches.length === 0 || remaining <= 0) return;
				/* A search that answered no URLs, such as an OpenAI search whose
				   sources were not returned, is reported with what the model cited. */
				const latest = searches.at(-1)!;
				if (latest.results.length === 0) {
					for (const [url, citation] of cited) {
						latest.results.push({ url, title: citation.title ?? '' });
					}
				}
				const kept =
					searches.length <= remaining
						? searches
						: [
								...searches.slice(0, remaining - 1),
								{
									query: searches[remaining - 1]!.query,
									results: searches
										.slice(remaining - 1)
										.flatMap((search) => search.results),
								},
							];
				for (const search of kept) {
					reported += 1;
					await options.report({
						query: search.query,
						results: search.results.map((item) => {
							const citation = cited.get(item.url);
							return {
								url: item.url,
								title: item.title || (citation?.title ?? ''),
								snippet: citation?.snippet ?? '',
								...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
								source: options.kind,
							};
						}),
					});
				}
			};
			const observe = async (part: ModelStreamPart): Promise<void> => {
				if (part.type === 'tool-call' && part.toolName === options.toolName) {
					calls.set(part.toolCallId, callQuery(part.input));
				} else if (
					part.type === 'tool-result' &&
					part.toolName === options.toolName
				) {
					/* A search the provider refused, such as one past max uses, found
					   nothing to report. */
					const search = part.isError
						? null
						: searchOf(
								options.kind,
								part.result,
								calls.get(part.toolCallId) ?? null,
							);
					if (search) pending.push(search);
				} else if (part.type === 'source' && part.sourceType === 'url') {
					const current = citations.get(part.url);
					citations.set(part.url, {
						title: current?.title ?? textOf(part.title),
						snippet:
							current?.snippet ??
							textOf(objectOf(part.providerMetadata?.anthropic).citedText),
					});
				} else if (part.type === 'finish') {
					await flush();
				}
			};
			return {
				...rest,
				stream: stream.pipeThrough(
					new TransformStream<ModelStreamPart, ModelStreamPart>({
						async transform(part, controller) {
							await observe(part);
							controller.enqueue(part);
						},
						flush,
					}),
				),
			};
		},
	};
}
