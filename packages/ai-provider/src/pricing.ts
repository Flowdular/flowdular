import { AI_PROVIDER_CATALOG } from './catalog.ts';

export interface AiModelPrice {
	/* Micro-USD (millionths of a dollar) per one million tokens. */
	readonly inputPerMillionMicros: number;
	readonly outputPerMillionMicros: number;
}

/* Published list prices for the models the catalog names. A model that is not
   listed costs `null`, never a guessed number: an invented price is worse than
   an admitted gap when the number gates a budget. Deployments that configure
   their own model identifiers (OpenAI, Azure, compatible, gateway) are
   therefore unpriced until their price is published here. */
export const AI_MODEL_PRICES: Readonly<Record<string, AiModelPrice>> =
	Object.freeze({
		'claude-fable-5': {
			inputPerMillionMicros: 10_000_000,
			outputPerMillionMicros: 50_000_000,
		},
		'claude-opus-5': {
			inputPerMillionMicros: 5_000_000,
			outputPerMillionMicros: 25_000_000,
		},
		'claude-sonnet-5': {
			inputPerMillionMicros: 2_000_000,
			outputPerMillionMicros: 10_000_000,
		},
		'claude-haiku-4-5': {
			inputPerMillionMicros: 1_000_000,
			outputPerMillionMicros: 5_000_000,
		},
	});

/* Gateway kinds address the same model as `vendor/model`, so the last path
   segment decides, exactly as the temperature policy resolves it. */
function modelName(modelId: string): string {
	const normalized = modelId.trim().toLowerCase();
	return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function modelPrice(modelId: string): AiModelPrice | null {
	return AI_MODEL_PRICES[modelName(modelId)] ?? null;
}

export interface AiTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/* Cost in micro-USD, or null when the model has no published price. Integer
   arithmetic throughout so a rollup of many runs cannot drift by a fraction
   of a cent per row. */
export function usageCostMicros(
	modelId: string,
	usage: AiTokenUsage,
): number | null {
	const price = modelPrice(modelId);
	if (!price) return null;
	const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
	const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
	return (
		Math.round((inputTokens * price.inputPerMillionMicros) / 1_000_000) +
		Math.round((outputTokens * price.outputPerMillionMicros) / 1_000_000)
	);
}

/* Every catalog model must carry a price; a model added to the catalog without
   one silently becomes unpriced everywhere it is used. */
export function unpricedCatalogModels(): readonly string[] {
	return Object.values(AI_PROVIDER_CATALOG)
		.flatMap((descriptor) => descriptor.models)
		.filter((model) => modelPrice(model) === null);
}
