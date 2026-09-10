/* Pure catalog data for clients. The package root pulls in the AI SDK
   adapters, which a browser bundle must not load. */
export {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
	AI_TEMPERATURE_POLICY,
	defaultModelFor,
	isAiProviderKind,
	modelSupportsTemperature,
} from '@flowdular/ai-provider/catalog';
export type {
	AiProviderKind,
	AiProviderKindDescriptor,
} from '@flowdular/ai-provider/catalog';
export {
	AI_MODEL_PRICES,
	modelPrice,
	unpricedCatalogModels,
	usageCostMicros,
} from '@flowdular/ai-provider/pricing';
export type {
	AiModelPrice,
	AiTokenUsage,
} from '@flowdular/ai-provider/pricing';
