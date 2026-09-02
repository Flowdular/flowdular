import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import {
	AI_PROVIDER_CATALOG,
	modelSupportsTemperature,
	type AiProviderKind,
} from './catalog.ts';
import { AiProviderError, classifyProviderFailure } from './errors.ts';

export interface AiProviderConfiguration {
	readonly kind: AiProviderKind;
	readonly model: string;
	readonly credential: string;
	readonly resourceName?: string | undefined;
	readonly baseURL?: string | undefined;
	readonly fetch?: typeof globalThis.fetch | undefined;
	/* Overrides the catalog rule for this model. Absent means the catalog
	   decides whether a temperature is sent. */
	readonly supportsTemperature?: boolean | undefined;
}

export interface AiUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

export interface ProviderReadinessResult {
	readonly healthy: boolean;
	readonly latencyMs: number;
	readonly errorCode: string | null;
	/* The provider's own reason, redacted. For server diagnostics only. */
	readonly detail: string | null;
}

function required(value: string, field: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum || /\s/.test(normalized)) {
		throw new AiProviderError(
			'INVALID_PROVIDER_CONFIGURATION',
			`${field} is invalid.`,
		);
	}
	return normalized;
}

function assertSecureProviderUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AiProviderError(
			'INVALID_PROVIDER_CONFIGURATION',
			'baseURL must be an absolute URL.',
		);
	}
	if (url.username || url.password) {
		throw new AiProviderError(
			'INVALID_PROVIDER_CONFIGURATION',
			'baseURL must not contain URL credentials.',
		);
	}
	const loopback =
		url.hostname === 'localhost' ||
		url.hostname === '::1' ||
		url.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new AiProviderError(
			'INVALID_PROVIDER_CONFIGURATION',
			'baseURL must use HTTPS unless the provider is on loopback.',
		);
	}
}

export function assertProviderConfiguration(
	configuration: AiProviderConfiguration,
): void {
	required(configuration.model, 'model', 160);
	required(configuration.credential, 'credential', 16_384);
	for (const field of AI_PROVIDER_CATALOG[configuration.kind].requires) {
		required(
			configuration[field] ?? '',
			field,
			field === 'baseURL' ? 2_048 : 120,
		);
	}
	if (configuration.kind === 'openai-compatible') {
		assertSecureProviderUrl(configuration.baseURL ?? '');
	}
}

export function resolveLanguageModel(
	configuration: AiProviderConfiguration,
): LanguageModel {
	assertProviderConfiguration(configuration);
	const model = configuration.model.trim();
	const apiKey = configuration.credential.trim();
	const providerFetch = configuration.fetch;
	const fetchOption = providerFetch ? { fetch: providerFetch } : {};
	switch (configuration.kind) {
		case 'vercel':
			return createGateway({ apiKey, ...fetchOption })(model);
		case 'azure':
			return createAzure({
				apiKey,
				resourceName: (configuration.resourceName ?? '').trim(),
				...fetchOption,
			})(model);
		case 'openai':
			return createOpenAI({ apiKey, ...fetchOption }).responses(model);
		case 'anthropic':
			return createAnthropic({ apiKey, ...fetchOption })(model);
		case 'openai-compatible':
			return createOpenAICompatible({
				name: 'coreloom-compatible',
				apiKey,
				baseURL: (configuration.baseURL ?? '').trim(),
				...fetchOption,
			})(model);
	}
}

/* Every request to a model, probe or run, decides the temperature parameter
   here so a model that rejects it fails at Test time and not on the first run. */
export function temperatureSetting(
	configuration: AiProviderConfiguration,
	temperature: number,
): { readonly temperature?: number } {
	const supported =
		configuration.supportsTemperature ??
		modelSupportsTemperature(configuration.kind, configuration.model);
	return supported ? { temperature } : {};
}

export function normalizeUsage(value: {
	readonly inputTokens: number | undefined;
	readonly outputTokens: number | undefined;
	readonly totalTokens: number | undefined;
}): AiUsage {
	const inputTokens = value.inputTokens ?? 0;
	const outputTokens = value.outputTokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		totalTokens: value.totalTokens ?? inputTokens + outputTokens,
	};
}

/* OpenAI's Responses API rejects a max_output_tokens below 16, and a
   reasoning model spends part of the budget before it writes anything. The
   probe only has to prove authentication and model access, so it buys a small
   budget and accepts an answer that the budget cut short. */
const PROBE_OUTPUT_TOKENS = 64;
const PROBE_TEMPERATURE = 0;

/* A bounded request that proves authentication and model access without
   exposing the response body. */
export async function probeLanguageModel(
	configuration: AiProviderConfiguration,
	timeoutMs = 10_000,
): Promise<ProviderReadinessResult> {
	const startedAt = Date.now();
	try {
		const result = await generateText({
			model: resolveLanguageModel(configuration),
			prompt: 'Reply with OK.',
			...temperatureSetting(configuration, PROBE_TEMPERATURE),
			maxOutputTokens: PROBE_OUTPUT_TOKENS,
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(timeoutMs),
		});
		if (!result.text.trim() && result.finishReason !== 'length') {
			throw new AiProviderError(
				'PROVIDER_EMPTY_RESPONSE',
				'The readiness probe returned no text.',
			);
		}
		return {
			healthy: true,
			latencyMs: Date.now() - startedAt,
			errorCode: null,
			detail: null,
		};
	} catch (error) {
		const failure = classifyProviderFailure(error);
		return {
			healthy: false,
			latencyMs: Date.now() - startedAt,
			errorCode: failure.code,
			detail: failure.detail,
		};
	}
}
