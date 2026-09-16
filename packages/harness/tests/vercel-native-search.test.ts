import { describe, expect, it } from 'vitest';
import { userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	createVercelAiSdkProvider,
	NATIVE_TOOL_UNSUPPORTED,
	type AgentExecutionEvent,
	type AgentExecutionRequest,
	type AgentNativeResult,
	type AgentNativeTool,
	type VercelAiProviderConfiguration,
} from '../src/index.ts';

const PERMISSION = 'research.run';
const NATIVE_ID = 'research.web-search';

function request(
	provider: string,
	model: string,
	tools: readonly string[],
): AgentExecutionRequest {
	return {
		runId: 'run-search',
		tenantId: 'tenant-a',
		requestedBy: 'account-a',
		requestedActor: userActor({
			accountId: 'account-a',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Who insures Acme?',
		definition: {
			id: 'agent-1',
			name: 'Researcher',
			revision: 1,
			instructions: 'Search the web and cite what you found.',
			provider,
			model,
			allowedTools: [...tools],
			maxSteps: 2,
			timeoutMs: 5_000,
			temperature: 0,
		},
		permissionSnapshot: [PERMISSION],
		toolGrants: [...tools],
	};
}

function sse(events: readonly unknown[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
		{ headers: { 'content-type': 'text/event-stream' } },
	);
}

interface Captured {
	body: Record<string, unknown>;
}

async function execute(
	configuration: Omit<VercelAiProviderConfiguration, 'fetch'>,
	answer: (call: number) => Response,
	options: {
		readonly authorizeToolAccess?: () => readonly string[];
		readonly nativeTools?: readonly AgentNativeTool[];
	} = {},
) {
	const captured: Captured[] = [];
	const recorded: {
		readonly query: string | null;
		readonly results: readonly AgentNativeResult[];
		readonly unsupported?: {
			readonly code: string;
			readonly detail: string | null;
		};
	}[] = [];
	const events: AgentExecutionEvent[] = [];
	const provider = createVercelAiSdkProvider({
		...configuration,
		fetch: async (_input, init) => {
			captured.push({
				body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
			});
			return answer(captured.length);
		},
	});
	const harness = new AgentHarness({
		providers: [provider],
		nativeTools: [
			{
				id: NATIVE_ID,
				kind: 'web-search',
				config: { maxResults: 20 },
				requiredPermissions: [PERMISSION],
				resolveConfig: () => ({ allowedDomains: ['acme.example'] }),
				record: async (report) => {
					recorded.push(report);
				},
			},
			...(options.nativeTools ?? []),
		],
		authorizeToolAccess: options.authorizeToolAccess ?? (() => [PERMISSION]),
	});
	let failure: unknown = null;
	const result = await harness
		.execute(
			request(configuration.id, configuration.model, [
				NATIVE_ID,
				...(options.nativeTools ?? []).map((tool) => tool.id),
			]),
			{ onEvent: (event) => events.push(event) },
		)
		.catch((error: unknown) => {
			failure = error;
			return null;
		});
	return {
		result,
		failure,
		captured,
		recorded,
		native: events
			.filter((event) => event.type === 'tool.native')
			.map((event) => event.metadata),
	};
}

const anthropicStream = [
	{
		type: 'message_start',
		message: {
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-sonnet-5',
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 12, output_tokens: 1 },
		},
	},
	{
		type: 'content_block_start',
		index: 0,
		content_block: {
			type: 'server_tool_use',
			id: 'srvtoolu_1',
			name: 'web_search',
			input: {},
		},
	},
	{
		type: 'content_block_delta',
		index: 0,
		delta: {
			type: 'input_json_delta',
			partial_json: '{"query":"acme insurance"}',
		},
	},
	{ type: 'content_block_stop', index: 0 },
	{
		type: 'content_block_start',
		index: 1,
		content_block: {
			type: 'web_search_tool_result',
			tool_use_id: 'srvtoolu_1',
			content: [
				{
					type: 'web_search_result',
					url: 'https://acme.example/about',
					title: 'About Acme',
					encrypted_content: 'opaque',
					page_age: 'April 30, 2025',
				},
				{
					type: 'web_search_result',
					url: 'https://acme.example/claims',
					title: null,
					encrypted_content: 'opaque',
				},
			],
		},
	},
	{ type: 'content_block_stop', index: 1 },
	{
		type: 'content_block_start',
		index: 2,
		content_block: { type: 'text', text: '' },
	},
	{
		type: 'content_block_delta',
		index: 2,
		delta: {
			type: 'citations_delta',
			citation: {
				type: 'web_search_result_location',
				url: 'https://acme.example/about',
				title: 'About Acme',
				cited_text: 'Acme insures cargo ships.',
				encrypted_index: 'opaque',
			},
		},
	},
	{
		type: 'content_block_delta',
		index: 2,
		delta: { type: 'text_delta', text: 'Acme insures cargo ships.' },
	},
	{ type: 'content_block_stop', index: 2 },
	{
		type: 'message_delta',
		delta: { stop_reason: 'end_turn', stop_sequence: null },
		usage: { output_tokens: 9 },
	},
	{ type: 'message_stop' },
];

const anthropicText = [
	anthropicStream[0],
	{
		type: 'content_block_start',
		index: 0,
		content_block: { type: 'text', text: '' },
	},
	{
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'text_delta', text: 'Acme insures cargo ships.' },
	},
	{ type: 'content_block_stop', index: 0 },
	...anthropicStream.slice(-2),
];

function errorResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

const anthropic = {
	id: 'provider.anthropic',
	kind: 'anthropic',
	model: 'claude-sonnet-5',
	credential: 'sk-ant-test-credential',
} as const;

const openai = {
	id: 'provider.openai',
	kind: 'openai',
	model: 'gpt-5-mini',
	credential: 'sk-test-credential',
} as const;

function responsesStream(
	items: readonly Readonly<Record<string, unknown>>[],
): unknown[] {
	return [
		{
			type: 'response.created',
			response: { id: 'resp_1', created_at: 1, model: 'gpt-5-mini' },
		},
		...items,
		{
			type: 'response.output_item.added',
			output_index: 9,
			item: { type: 'message', id: 'msg_1' },
		},
		{
			type: 'response.output_text.delta',
			item_id: 'msg_1',
			output_index: 9,
			delta: 'Acme insures cargo ships.',
		},
		{
			type: 'response.output_item.done',
			output_index: 9,
			item: {
				type: 'message',
				role: 'assistant',
				id: 'msg_1',
				content: [
					{
						type: 'output_text',
						text: 'Acme insures cargo ships.',
						annotations: [],
					},
				],
			},
		},
		{
			type: 'response.completed',
			response: {
				usage: { input_tokens: 12, output_tokens: 9 },
			},
		},
	];
}

describe('Vercel AI SDK native web search', () => {
	it('passes the Anthropic web search through and records its citations', async () => {
		const { result, captured, recorded, native } = await execute(
			{
				id: 'provider.anthropic',
				kind: 'anthropic',
				model: 'claude-sonnet-5',
				credential: 'sk-ant-test-credential',
			},
			() => sse(anthropicStream),
		);
		expect(result?.output).toBe('Acme insures cargo ships.');
		expect(captured).toHaveLength(1);
		expect(captured[0]!.body.tools).toEqual([
			{
				type: 'web_search_20250305',
				name: 'web_search',
				max_uses: 5,
				allowed_domains: ['acme.example'],
			},
		]);
		expect(recorded).toEqual([
			{
				query: 'acme insurance',
				results: [
					{
						url: 'https://acme.example/about',
						title: 'About Acme',
						snippet: 'Acme insures cargo ships.',
						publishedAt: 'April 30, 2025',
						source: 'anthropic',
					},
					{
						url: 'https://acme.example/claims',
						title: '',
						snippet: '',
						source: 'anthropic',
					},
				],
			},
		]);
		expect(native).toEqual([{ tool: NATIVE_ID, results: 2 }]);
	});

	it('passes one web search per request and reports a second one as unsupported', async () => {
		const second = 'zeta.web-search';
		const { captured, native } = await execute(
			{
				id: 'provider.anthropic',
				kind: 'anthropic',
				model: 'claude-sonnet-5',
				credential: 'sk-ant-test-credential',
			},
			() => sse(anthropicStream),
			{
				nativeTools: [
					{
						id: second,
						kind: 'web-search',
						config: {},
						requiredPermissions: [PERMISSION],
					},
				],
			},
		);
		expect(captured[0]!.body.tools).toHaveLength(1);
		expect(native).toEqual([
			{ tool: second, reason: NATIVE_TOOL_UNSUPPORTED },
			{ tool: NATIVE_ID, results: 2 },
		]);
	});

	it('passes the OpenAI web search through and records its sources', async () => {
		const { result, captured, recorded, native } = await execute(
			{
				id: 'provider.openai',
				kind: 'openai',
				model: 'gpt-5-mini',
				credential: 'sk-test-credential',
			},
			() =>
				sse(
					responsesStream([
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: {
								type: 'web_search_call',
								id: 'ws_1',
								status: 'searching',
							},
						},
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: {
								type: 'web_search_call',
								id: 'ws_1',
								status: 'completed',
								action: {
									type: 'search',
									queries: ['acme insurance'],
									sources: [{ type: 'url', url: 'https://acme.example/about' }],
								},
							},
						},
						{
							type: 'response.output_text.annotation.added',
							annotation: {
								type: 'url_citation',
								start_index: 0,
								end_index: 25,
								url: 'https://acme.example/about',
								title: 'About Acme',
							},
						},
					]),
				),
		);
		expect(result?.output).toBe('Acme insures cargo ships.');
		expect(captured[0]!.body).toMatchObject({
			tools: [
				{ type: 'web_search', filters: { allowed_domains: ['acme.example'] } },
			],
			max_tool_calls: 5,
		});
		expect(captured[0]!.body.include).toContain(
			'web_search_call.action.sources',
		);
		expect(recorded).toEqual([
			{
				query: 'acme insurance',
				results: [
					{
						url: 'https://acme.example/about',
						title: 'About Acme',
						snippet: '',
						source: 'openai',
					},
				],
			},
		]);
		expect(native).toEqual([{ tool: NATIVE_ID, results: 1 }]);
	});

	it('fails the run with the harness code when the permission is gone by the time the search reports', async () => {
		let checks = 0;
		const { failure } = await execute(
			{
				id: 'provider.anthropic',
				kind: 'anthropic',
				model: 'claude-sonnet-5',
				credential: 'sk-ant-test-credential',
			},
			() => sse(anthropicStream),
			{ authorizeToolAccess: () => (++checks === 1 ? [PERMISSION] : []) },
		);
		expect(checks).toBe(2);
		expect(failure).toMatchObject({ code: 'TOOL_AUTHORIZATION_REVOKED' });
	});

	it.each([
		{
			configuration: anthropic,
			refusal: () =>
				errorResponse(400, {
					type: 'error',
					error: {
						type: 'invalid_request_error',
						message:
							'Web search is not enabled for this organization. An administrator can enable it in the Console.',
					},
				}),
			answer: () => sse(anthropicText),
		},
		{
			configuration: openai,
			refusal: () =>
				errorResponse(400, {
					error: {
						message:
							"Hosted tool 'web_search' is not supported with gpt-5-mini.",
						type: 'invalid_request_error',
						param: 'tools',
						code: null,
					},
				}),
			answer: () => sse(responsesStream([])),
		},
	])(
		'retries a $configuration.kind call that refused the web search tool once without it and completes the run',
		async ({ configuration, refusal, answer }) => {
			const { result, failure, captured, recorded, native } = await execute(
				configuration,
				(call) => (call === 1 ? refusal() : answer()),
			);
			expect(failure).toBeNull();
			expect(result?.output).toBe('Acme insures cargo ships.');
			expect(captured).toHaveLength(2);
			expect(JSON.stringify(captured[0]!.body)).toContain('web_search');
			expect(JSON.stringify(captured[1]!.body)).not.toContain('web_search');
			expect(captured[1]!.body).not.toHaveProperty('max_tool_calls');
			expect(recorded).toEqual([
				{
					query: null,
					results: [],
					unsupported: {
						code: NATIVE_TOOL_UNSUPPORTED,
						detail: 'PROVIDER_WEB_SEARCH_DISABLED',
					},
				},
			]);
			expect(native).toEqual([
				{
					tool: NATIVE_ID,
					reason: NATIVE_TOOL_UNSUPPORTED,
					detail: 'PROVIDER_WEB_SEARCH_DISABLED',
				},
			]);
		},
	);

	it.each([
		{
			configuration: anthropic,
			rejection: () =>
				errorResponse(400, {
					type: 'error',
					error: {
						type: 'invalid_request_error',
						message:
							'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-5',
					},
				}),
		},
		{
			configuration: openai,
			rejection: () =>
				errorResponse(400, {
					error: {
						message:
							"Invalid 'max_output_tokens': integer below minimum value.",
						type: 'invalid_request_error',
						param: 'max_output_tokens',
						code: 'integer_below_min_value',
					},
				}),
		},
	])(
		'still fails a $configuration.kind run on a 400 that does not name web search',
		async ({ configuration, rejection }) => {
			const { failure, captured, native } = await execute(
				configuration,
				rejection,
			);
			expect(failure).toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
			expect(captured).toHaveLength(1);
			expect(native).toEqual([]);
		},
	);

	it.each([
		{
			configuration: {
				id: 'provider.azure',
				kind: 'azure',
				model: 'deployment',
				credential: 'azure-test-credential',
				resourceName: 'flowdular-test',
			},
			answer: () => sse(responsesStream([])),
		},
		{
			configuration: {
				id: 'provider.compatible',
				kind: 'openai-compatible',
				model: 'llama-3.3-70b',
				credential: 'compatible-test-credential',
				baseURL: 'https://models.example.test/v1',
			},
			answer: () =>
				sse([
					{
						id: 'chat_1',
						created: 1,
						model: 'llama-3.3-70b',
						choices: [
							{
								index: 0,
								delta: {
									role: 'assistant',
									content: 'Acme insures cargo ships.',
								},
								finish_reason: null,
							},
						],
					},
					{
						id: 'chat_1',
						created: 1,
						model: 'llama-3.3-70b',
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
						usage: { prompt_tokens: 12, completion_tokens: 9 },
					},
				]),
		},
		{
			configuration: {
				id: 'provider.vercel',
				kind: 'vercel',
				model: 'anthropic/claude-sonnet-5',
				credential: 'vercel-test-credential',
			},
			answer: () =>
				sse([
					{ type: 'text-start', id: 't' },
					{ type: 'text-delta', id: 't', delta: 'Acme insures cargo ships.' },
					{ type: 'text-end', id: 't' },
					{
						type: 'finish',
						finishReason: { unified: 'stop', raw: 'stop' },
						usage: {
							inputTokens: { total: 12 },
							outputTokens: { total: 9 },
						},
					},
				]),
		},
	] as const)(
		'reports NATIVE_TOOL_UNSUPPORTED on $configuration.kind and still completes the run',
		async ({ configuration, answer }) => {
			const { result, captured, recorded, native } = await execute(
				configuration,
				answer,
			);
			expect(result?.output).toBe('Acme insures cargo ships.');
			expect(native).toEqual([
				{ tool: NATIVE_ID, reason: NATIVE_TOOL_UNSUPPORTED },
			]);
			expect(recorded).toEqual([
				{
					query: null,
					results: [],
					unsupported: { code: NATIVE_TOOL_UNSUPPORTED, detail: null },
				},
			]);
			expect(JSON.stringify(captured[0]!.body)).not.toContain('web_search');
		},
	);
});
