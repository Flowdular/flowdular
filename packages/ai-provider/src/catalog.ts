export const AI_PROVIDER_KINDS = [
	'vercel',
	'azure',
	'openai',
	'openai-compatible',
	'anthropic',
] as const;

export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export interface AiProviderKindDescriptor {
	readonly kind: AiProviderKind;
	readonly label: string;
	/* Extra configuration a kind requires beyond a credential and a model. */
	readonly requires: readonly ('resourceName' | 'baseURL')[];
	/* Known model identifiers. Empty means the deployment supplies its own. */
	readonly models: readonly string[];
	readonly defaultModel: string | null;
}

/* One place owns provider kinds and their known models, so the platform agent
   runtime and the sandbox coding agent cannot drift apart. Kinds without a
   published, stable identifier list take the model id from configuration. */
export const AI_PROVIDER_CATALOG: Readonly<
	Record<AiProviderKind, AiProviderKindDescriptor>
> = Object.freeze({
	anthropic: {
		kind: 'anthropic',
		label: 'Anthropic',
		requires: [],
		models: [
			'claude-opus-5',
			'claude-sonnet-5',
			'claude-fable-5',
			'claude-haiku-4-5',
		],
		defaultModel: 'claude-sonnet-5',
	},
	openai: {
		kind: 'openai',
		label: 'OpenAI',
		requires: [],
		models: [],
		defaultModel: null,
	},
	azure: {
		kind: 'azure',
		label: 'Azure OpenAI',
		requires: ['resourceName'],
		models: [],
		defaultModel: null,
	},
	'openai-compatible': {
		kind: 'openai-compatible',
		label: 'OpenAI compatible',
		requires: ['baseURL'],
		models: [],
		defaultModel: null,
	},
	vercel: {
		kind: 'vercel',
		label: 'Vercel AI Gateway',
		requires: [],
		models: [],
		defaultModel: null,
	},
});

export function isAiProviderKind(value: string): value is AiProviderKind {
	return (AI_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function defaultModelFor(kind: AiProviderKind): string | null {
	return AI_PROVIDER_CATALOG[kind].defaultModel;
}

/* Anthropic's current models and OpenAI's reasoning families answer only at
   their own default temperature and reject the parameter. Matching a prefix
   is deliberately broad: leaving temperature out of a request is harmless,
   sending it to one of these models fails the run. */
export const AI_TEMPERATURE_POLICY = Object.freeze({
	kinds: Object.freeze(['anthropic'] as readonly AiProviderKind[]),
	modelPrefixes: Object.freeze([
		'claude-',
		'gpt-5',
		'o1',
		'o3',
		'o4',
	] as readonly string[]),
});

export function modelSupportsTemperature(
	kind: AiProviderKind,
	modelId: string,
): boolean {
	if (AI_TEMPERATURE_POLICY.kinds.includes(kind)) return false;
	const normalized = modelId.trim().toLowerCase();
	const name = normalized.slice(normalized.lastIndexOf('/') + 1);
	return !AI_TEMPERATURE_POLICY.modelPrefixes.some((prefix) =>
		name.startsWith(prefix),
	);
}
