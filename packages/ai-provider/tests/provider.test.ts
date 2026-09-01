import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
	AiProviderError,
	assertProviderConfiguration,
	classifyProviderFailure,
	defaultModelFor,
	isAiProviderKind,
	modelSupportsTemperature,
	normalizeUsage,
	probeLanguageModel,
	redactSecrets,
	resolveLanguageModel,
	temperatureSetting,
} from '../src/index.ts';

async function probeBody(
	configuration: Parameters<typeof probeLanguageModel>[0],
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	await probeLanguageModel({
		...configuration,
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			return new Response(JSON.stringify({ error: { message: 'stop' } }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		},
	});
	return body;
}

function apiCallError(statusCode: number, message: string): APICallError {
	return new APICallError({
		message,
		url: 'https://api.openai.com/v1/responses',
		requestBodyValues: {},
		statusCode,
	});
}

describe('provider catalog', () => {
	it('describes every supported kind exactly once', () => {
		for (const kind of AI_PROVIDER_KINDS) {
			expect(AI_PROVIDER_CATALOG[kind].kind).toBe(kind);
		}
		expect(Object.keys(AI_PROVIDER_CATALOG)).toHaveLength(
			AI_PROVIDER_KINDS.length,
		);
	});

	it('recognizes only supported kinds', () => {
		expect(isAiProviderKind('anthropic')).toBe(true);
		expect(isAiProviderKind('local-simulation')).toBe(false);
	});

	it('only offers a default model where one is published', () => {
		expect(defaultModelFor('anthropic')).toBe('claude-sonnet-5');
		expect(defaultModelFor('openai')).toBeNull();
	});

	it('lists undated Anthropic identifiers', () => {
		expect(AI_PROVIDER_CATALOG.anthropic.models).toContain('claude-haiku-4-5');
		expect(
			AI_PROVIDER_CATALOG.anthropic.models.some((id) => /\d{8}$/.test(id)),
		).toBe(false);
	});

	it.each([
		['anthropic', 'claude-sonnet-5', false],
		['openai', 'gpt-5-mini', false],
		['openai', 'o3-mini', false],
		['vercel', 'openai/o4-mini', false],
		['vercel', 'anthropic/claude-opus-5', false],
		['openai', 'gpt-4o-mini', true],
		['azure', 'my-deployment', true],
		['openai-compatible', 'llama-3.3-70b', true],
	] as const)(
		'decides the temperature default for %s %s',
		(kind, model, supported) => {
			expect(modelSupportsTemperature(kind, model)).toBe(supported);
		},
	);

	it('lets an explicit model flag override the catalog rule', () => {
		const base = { kind: 'anthropic', credential: 'secret-value' } as const;
		expect(
			temperatureSetting({ ...base, model: 'claude-sonnet-5' }, 0.3),
		).toEqual({});
		expect(
			temperatureSetting(
				{ ...base, model: 'claude-sonnet-5', supportsTemperature: true },
				0.3,
			),
		).toEqual({ temperature: 0.3 });
		expect(
			temperatureSetting(
				{ kind: 'openai', model: 'gpt-4o', credential: 'secret-value' },
				0.3,
			),
		).toEqual({ temperature: 0.3 });
	});
});

describe('provider configuration', () => {
	it('requires the extra field a kind declares', () => {
		expect(() =>
			assertProviderConfiguration({
				kind: 'azure',
				model: 'deployment',
				credential: 'secret-value',
			}),
		).toThrow(AiProviderError);
		expect(() =>
			assertProviderConfiguration({
				kind: 'openai-compatible',
				model: 'model',
				credential: 'secret-value',
				baseURL: 'https://models.example.test/v1',
			}),
		).not.toThrow();
	});

	it('rejects a blank credential before any network call', () => {
		expect(() =>
			resolveLanguageModel({
				kind: 'anthropic',
				model: 'claude-sonnet-5',
				credential: ' ',
			}),
		).toThrow(/credential is invalid/);
	});
});

describe('readiness probe', () => {
	it('asks for enough output tokens for the OpenAI responses API', async () => {
		let body: Record<string, unknown> = {};
		const result = await probeLanguageModel({
			kind: 'openai',
			model: 'gpt-4o-mini',
			credential: 'sk-probe-key',
			fetch: async (_input, init) => {
				body = JSON.parse(String(init?.body ?? '{}')) as Record<
					string,
					unknown
				>;
				return new Response(
					JSON.stringify({ error: { message: 'stop here' } }),
					{ status: 400, headers: { 'content-type': 'application/json' } },
				);
			},
		});

		/* Below 16 the API rejects every probe, whatever the key and model. */
		expect(body.max_output_tokens).toBeGreaterThanOrEqual(16);
		expect(result.healthy).toBe(false);
		expect(result.errorCode).toBe('PROVIDER_REQUEST_REJECTED');
	});

	it('sends the temperature parameter exactly when a run would', async () => {
		const chat = await probeBody({
			kind: 'openai',
			model: 'gpt-4o-mini',
			credential: 'sk-probe-key',
		});
		expect(chat).toHaveProperty('temperature');
		const reasoning = await probeBody({
			kind: 'openai',
			model: 'gpt-5-mini',
			credential: 'sk-probe-key',
		});
		expect(reasoning).not.toHaveProperty('temperature');
		const forced = await probeBody({
			kind: 'openai',
			model: 'gpt-4o-mini',
			credential: 'sk-probe-key',
			supportsTemperature: false,
		});
		expect(forced).not.toHaveProperty('temperature');
	});
});

describe('failure classification', () => {
	it.each([
		[
			apiCallError(400, "Invalid 'max_output_tokens'."),
			'PROVIDER_REQUEST_REJECTED',
		],
		[
			apiCallError(401, 'Incorrect API key provided.'),
			'PROVIDER_AUTHENTICATION_FAILED',
		],
		[
			apiCallError(403, 'Project does not have access.'),
			'PROVIDER_PERMISSION_DENIED',
		],
		[
			apiCallError(404, 'The model `gpt-9` does not exist.'),
			'PROVIDER_MODEL_NOT_FOUND',
		],
		[apiCallError(429, 'Slow down.'), 'PROVIDER_RATE_LIMITED'],
		[apiCallError(503, 'overloaded'), 'PROVIDER_UNAVAILABLE'],
	])('classifies a provider response by its status', (error, code) => {
		expect(classifyProviderFailure(error).code).toBe(code);
	});

	it('keeps the provider reason for server diagnostics without the key', () => {
		const failure = classifyProviderFailure(
			apiCallError(401, 'Incorrect API key provided: sk-live-abcdef123456.'),
		);
		expect(failure.detail).toBe('Incorrect API key provided: [redacted].');
		expect(redactSecrets('Authorization: Bearer abcdef123456')).toBe(
			'Authorization: Bearer [redacted]',
		);
	});

	it.each([
		[
			new Error('Request failed with status 401'),
			'PROVIDER_AUTHENTICATION_FAILED',
		],
		[new Error('403 permission denied'), 'PROVIDER_PERMISSION_DENIED'],
		[new Error('model not found'), 'PROVIDER_MODEL_NOT_FOUND'],
		[new Error('429 rate limit reached'), 'PROVIDER_RATE_LIMITED'],
		[new Error('socket hang up'), 'PROVIDER_REQUEST_FAILED'],
	])('maps a provider failure to a stable code', (error, code) => {
		expect(classifyProviderFailure(error).code).toBe(code);
	});

	it('keeps an already classified failure', () => {
		const failure = new AiProviderError('PROVIDER_TIMEOUT', 'too slow');
		expect(classifyProviderFailure(failure)).toBe(failure);
	});
});

describe('usage normalization', () => {
	it('fills a missing total from its parts', () => {
		expect(
			normalizeUsage({
				inputTokens: 3,
				outputTokens: 4,
				totalTokens: undefined,
			}),
		).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
	});
});
