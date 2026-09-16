import {
	APICallError,
	jsonSchema,
	streamText,
	tool,
	wrapLanguageModel,
	type ToolSet,
} from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
	AI_PROVIDER_KINDS,
	WEB_SEARCH_DISABLED,
	webSearchPassThrough,
	webSearchRefusal,
	webSearchReporter,
	type WebSearchReport,
} from '../src/index.ts';

const SEARCH = 'research_web_search';

type Part =
	Awaited<
		ReturnType<MockLanguageModelV4['doStream']>
	>['stream'] extends ReadableStream<infer P>
		? P
		: never;

const usage = {
	inputTokens: {
		total: 1,
		noCache: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const finish: Part = {
	type: 'finish',
	finishReason: { unified: 'stop', raw: 'end_turn' },
	usage,
};

function anthropicSearch(id: string, query: string, url: string): Part[] {
	return [
		{
			type: 'tool-call',
			toolCallId: id,
			toolName: SEARCH,
			input: JSON.stringify({ query }),
			providerExecuted: true,
		},
		{
			type: 'tool-result',
			toolCallId: id,
			toolName: SEARCH,
			result: [
				{
					type: 'web_search_result',
					url,
					title: `Title of ${url}`,
					pageAge: 'April 30, 2025',
					encryptedContent: 'opaque',
				},
			],
		},
	];
}

async function run(
	kind: 'anthropic' | 'openai',
	calls: readonly (readonly Part[])[],
	options: {
		readonly maxReports?: number;
		readonly tools?: ToolSet;
		readonly reports?: WebSearchReport[];
		readonly reportDelayMs?: number;
	} = {},
): Promise<WebSearchReport[]> {
	const reports = options.reports ?? [];
	const model = new MockLanguageModelV4({
		doStream: calls.map((parts) => ({
			stream: convertArrayToReadableStream([...parts]),
		})),
	});
	const result = streamText({
		model: wrapLanguageModel({
			model,
			middleware: webSearchReporter({
				kind,
				toolName: SEARCH,
				maxReports: options.maxReports ?? 16,
				report: async (report) => {
					await new Promise((resolve) =>
						setTimeout(resolve, options.reportDelayMs ?? 0),
					);
					reports.push(report);
				},
				unsupported: async () => {
					throw new Error('No refusal in this run.');
				},
			}),
		}),
		prompt: 'acme insurance',
		tools: {
			[SEARCH]: webSearchPassThrough(kind, {})!.tool,
			...options.tools,
		},
		stopWhen: ({ steps }) => steps.length >= calls.length,
	});
	await result.consumeStream({
		onError: (error) => {
			throw error;
		},
	});
	return reports;
}

describe('web search pass-through', () => {
	it('offers the provider tool for Anthropic and OpenAI only', () => {
		for (const kind of AI_PROVIDER_KINDS) {
			expect(webSearchPassThrough(kind, {}) !== null).toBe(
				kind === 'anthropic' || kind === 'openai',
			);
		}
		expect(webSearchPassThrough('anthropic', {})!.tool).toMatchObject({
			type: 'provider',
			id: 'anthropic.web_search_20250305',
			args: { maxUses: 5 },
		});
		expect(webSearchPassThrough('openai', {})).toMatchObject({
			tool: { type: 'provider', id: 'openai.web_search', args: {} },
			providerOptions: { openai: { maxToolCalls: 5 } },
		});
	});

	it('takes max uses from the config within bounds', () => {
		const uses = (value: unknown) =>
			(
				webSearchPassThrough('anthropic', { maxUses: value })!.tool as {
					args: { maxUses: number };
				}
			).args.maxUses;
		expect(uses(3)).toBe(3);
		expect(uses(99)).toBe(16);
		expect(uses(0)).toBe(5);
		expect(uses(2.5)).toBe(5);
		expect(uses('7')).toBe(5);
	});

	it('sends an allow list alone and a block list only without one', () => {
		const both = {
			allowedDomains: [' acme.example ', 7],
			blockedDomains: ['spam.example'],
		};
		expect(webSearchPassThrough('anthropic', both)!.tool).toMatchObject({
			args: { allowedDomains: ['acme.example'] },
		});
		expect(
			(webSearchPassThrough('anthropic', both)!.tool as { args: object }).args,
		).not.toHaveProperty('blockedDomains');
		expect(
			webSearchPassThrough('openai', {
				allowedDomains: [],
				blockedDomains: ['spam.example'],
			})!.tool,
		).toMatchObject({
			args: { filters: { blockedDomains: ['spam.example'] } },
		});
	});
});

describe('web search reporter', () => {
	it('maps an Anthropic search and its citations to results', async () => {
		const reports = await run('anthropic', [
			[
				...anthropicSearch('srv-1', 'acme insurance', 'https://acme.example/'),
				{
					type: 'source',
					sourceType: 'url',
					id: 'source-1',
					url: 'https://acme.example/',
					title: 'Cited title',
					providerMetadata: {
						anthropic: { citedText: 'Acme insures ships.' },
					},
				},
				{ type: 'text-start', id: 't' },
				{ type: 'text-delta', id: 't', delta: 'Acme insures ships.' },
				{ type: 'text-end', id: 't' },
				finish,
			],
		]);
		expect(reports).toEqual([
			{
				query: 'acme insurance',
				results: [
					{
						url: 'https://acme.example/',
						title: 'Title of https://acme.example/',
						snippet: 'Acme insures ships.',
						publishedAt: 'April 30, 2025',
						source: 'anthropic',
					},
				],
			},
		]);
	});

	it('maps an OpenAI search action, its sources and the cited titles', async () => {
		const reports = await run('openai', [
			[
				{
					type: 'tool-call',
					toolCallId: 'ws-1',
					toolName: SEARCH,
					input: '{}',
					providerExecuted: true,
				},
				{
					type: 'tool-result',
					toolCallId: 'ws-1',
					toolName: SEARCH,
					result: {
						action: {
							type: 'search',
							query: 'acme',
							queries: ['acme insurance', 'acme ships'],
						},
						sources: [
							{ type: 'url', url: 'https://acme.example/about' },
							{ type: 'api', name: 'oai-weather' },
							{ type: 'url', url: 'https://news.example/acme' },
						],
					},
				},
				{
					type: 'source',
					sourceType: 'url',
					id: 'source-1',
					url: 'https://acme.example/about',
					title: 'About Acme',
				},
				finish,
			],
		]);
		expect(reports).toEqual([
			{
				query: 'acme insurance',
				results: [
					{
						url: 'https://acme.example/about',
						title: 'About Acme',
						snippet: '',
						source: 'openai',
					},
					{
						url: 'https://news.example/acme',
						title: '',
						snippet: '',
						source: 'openai',
					},
				],
			},
		]);
	});

	it('reports a search before a tool the model calls next runs', async () => {
		const reports: WebSearchReport[] = [];
		const seen: number[] = [];
		await run(
			'anthropic',
			[
				[
					...anthropicSearch('srv-1', 'acme', 'https://acme.example/'),
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'research_search',
						input: JSON.stringify({ query: 'acme' }),
					},
					{
						...finish,
						finishReason: { unified: 'tool-calls', raw: 'tool_use' },
					},
				],
				[finish],
			],
			{
				reports,
				reportDelayMs: 50,
				tools: {
					research_search: tool({
						inputSchema: jsonSchema<{ query: string }>({
							type: 'object',
							properties: { query: { type: 'string' } },
						}),
						execute: async () => {
							seen.push(reports.length);
							return { ok: true };
						},
					}),
				},
			},
		);
		expect(seen).toEqual([1]);
		expect(reports).toHaveLength(1);
	});

	it('skips a refused search, a page action and gives a search without sources the cited URLs', async () => {
		const reports = await run('openai', [
			[
				{
					type: 'tool-result',
					toolCallId: 'ws-0',
					toolName: SEARCH,
					isError: true,
					result: { type: 'web_search_tool_result_error' },
				},
				{
					type: 'tool-result',
					toolCallId: 'ws-open',
					toolName: SEARCH,
					result: {
						action: { type: 'openPage', url: 'https://acme.example/' },
					},
				},
				{
					type: 'tool-result',
					toolCallId: 'ws-1',
					toolName: SEARCH,
					result: { action: { type: 'search', query: 'acme' } },
				},
				{
					type: 'source',
					sourceType: 'url',
					id: 'source-1',
					url: 'https://acme.example/',
					title: 'Acme',
				},
				finish,
			],
		]);
		expect(reports).toEqual([
			{
				query: 'acme',
				results: [
					{
						url: 'https://acme.example/',
						title: 'Acme',
						snippet: '',
						source: 'openai',
					},
				],
			},
		]);
	});

	it('merges searches past the report limit into the last report it allows', async () => {
		const reports = await run(
			'anthropic',
			[
				[
					...anthropicSearch('srv-1', 'first', 'https://one.example/'),
					...anthropicSearch('srv-2', 'second', 'https://two.example/'),
					...anthropicSearch('srv-3', 'third', 'https://three.example/'),
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'noop',
						input: '{}',
					},
					{
						...finish,
						finishReason: { unified: 'tool-calls', raw: 'tool_use' },
					},
				],
				[
					...anthropicSearch('srv-4', 'fourth', 'https://four.example/'),
					finish,
				],
			],
			{
				maxReports: 2,
				tools: {
					noop: tool({
						inputSchema: jsonSchema<object>({ type: 'object' }),
						execute: async () => ({}),
					}),
				},
			},
		);
		expect(
			reports.map((report) => [
				report.query,
				report.results.map((result) => result.url),
			]),
		).toEqual([
			['first', ['https://one.example/']],
			['second', ['https://two.example/', 'https://three.example/']],
		]);
	});
});

function apiError(statusCode: number, body: unknown): APICallError {
	return new APICallError({
		message: 'The provider refused the request.',
		url: 'https://api.example.test/v1/messages',
		requestBodyValues: {},
		statusCode,
		responseBody: JSON.stringify(body),
		isRetryable: false,
	});
}

const noop = tool({
	inputSchema: jsonSchema<object>({ type: 'object' }),
	execute: async () => ({}),
});

async function refusedRun(first: unknown) {
	const unsupported: string[] = [];
	const errors: unknown[] = [];
	const passThrough = webSearchPassThrough('openai', {})!;
	const toolStep: Part[] = [
		{ type: 'tool-call', toolCallId: 'call-1', toolName: 'noop', input: '{}' },
		{
			type: 'finish',
			finishReason: { unified: 'tool-calls', raw: 'tool_use' },
			usage,
		},
	];
	let call = 0;
	const model = new MockLanguageModelV4({
		doStream: async () => {
			call += 1;
			if (call === 1) throw first;
			return {
				stream: convertArrayToReadableStream(call === 2 ? toolStep : [finish]),
			};
		},
	});
	const result = streamText({
		model: wrapLanguageModel({
			model,
			middleware: webSearchReporter({
				kind: 'openai',
				toolName: SEARCH,
				maxReports: 16,
				report: async () => undefined,
				unsupported: async (reason) => {
					unsupported.push(reason);
				},
			}),
		}),
		prompt: 'acme insurance',
		tools: { [SEARCH]: passThrough.tool, noop },
		providerOptions: passThrough.providerOptions!,
		stopWhen: ({ steps }) => steps.length >= 2,
		maxRetries: 0,
	});
	for await (const part of result.fullStream) {
		if (part.type === 'error') errors.push(part.error);
	}
	return {
		unsupported,
		errors,
		calls: model.doStreamCalls.map((call) => ({
			tools: (call.tools ?? []).map((entry) => entry.name),
			providerOptions: call.providerOptions,
		})),
	};
}

describe('web search refusal', () => {
	it.each([
		[
			'an Anthropic request error naming the tool type',
			apiError(400, {
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message:
						"tools.0: Input tag 'web_search_20250305' found using 'type' does not match any of the expected tags",
				},
			}),
			WEB_SEARCH_DISABLED,
		],
		[
			'an Anthropic permission error naming web search',
			apiError(403, {
				type: 'error',
				error: {
					type: 'permission_error',
					message: 'Web search is not enabled for this organization.',
				},
			}),
			WEB_SEARCH_DISABLED,
		],
		[
			'an OpenAI request error naming the hosted tool',
			apiError(400, {
				error: {
					message:
						"Hosted tool 'web_search' is not supported with gpt-4.1-nano.",
					type: 'invalid_request_error',
					param: 'tools',
					code: null,
				},
			}),
			WEB_SEARCH_DISABLED,
		],
		[
			'a generic 400',
			apiError(400, {
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'max_tokens: 100000 > 64000, which is the maximum allowed',
				},
			}),
			null,
		],
		[
			'a 429 that names web search',
			apiError(429, {
				type: 'error',
				error: {
					type: 'rate_limit_error',
					message: 'Too many web search requests.',
				},
			}),
			null,
		],
		[
			'a 400 whose error type is not a request error',
			apiError(400, {
				error: { type: 'server_error', message: 'web_search failed' },
			}),
			null,
		],
		[
			'a 500 whose body names web search',
			apiError(500, {
				error: { message: 'The web_search backend is unavailable.' },
			}),
			null,
		],
		['an error that is not a provider response', new Error('web search'), null],
	])('classifies %s', (_label, error, code) => {
		expect(webSearchRefusal(error)).toBe(code);
	});

	it('retries a call refused over its web search tool once without it, and keeps it out afterwards', async () => {
		const { unsupported, errors, calls } = await refusedRun(
			apiError(400, {
				error: {
					message:
						"Hosted tool 'web_search' is not supported with gpt-4.1-nano.",
					type: 'invalid_request_error',
					param: 'tools',
				},
			}),
		);
		expect(errors).toEqual([]);
		expect(unsupported).toEqual([WEB_SEARCH_DISABLED]);
		expect(calls).toEqual([
			{
				tools: [SEARCH, 'noop'],
				providerOptions: { openai: { maxToolCalls: 5 } },
			},
			{ tools: ['noop'], providerOptions: { openai: {} } },
			{ tools: ['noop'], providerOptions: { openai: {} } },
		]);
	});

	it('keeps any other failure', async () => {
		const refused = apiError(400, {
			error: {
				message: "Invalid 'max_output_tokens': integer below minimum value.",
				type: 'invalid_request_error',
				param: 'max_output_tokens',
			},
		});
		const { unsupported, errors, calls } = await refusedRun(refused);
		expect(unsupported).toEqual([]);
		expect(errors).toEqual([refused]);
		expect(calls).toHaveLength(1);
	});
});
