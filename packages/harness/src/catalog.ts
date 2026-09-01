/* Pure catalog data for clients. The package root pulls in the AI SDK
   adapters, which a browser bundle must not load. */
export {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
	AI_TEMPERATURE_POLICY,
	defaultModelFor,
	isAiProviderKind,
	modelSupportsTemperature,
} from '@coreloom/ai-provider/catalog';
export type {
	AiProviderKind,
	AiProviderKindDescriptor,
} from '@coreloom/ai-provider/catalog';
