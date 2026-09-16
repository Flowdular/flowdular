import {
	defineModuleSettings,
	type ModuleSettingDefinition,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import {
	RESEARCH_ADAPTERS,
	RESEARCH_CHAIN_LIMITS,
	RESEARCH_FALLBACK_MODES,
	RESEARCH_FETCH_ADAPTERS,
	RESEARCH_LIMITS,
	RESEARCH_MODULE_ID,
	type ResearchAdapterKey,
	type ResearchAdapterLimits,
	type ResearchChainAdapterKey,
	type ResearchFallbackMode,
	type ResearchFetchAdapterKey,
	type ResearchSettings,
} from './domain/types.ts';

function setting(
	key: string,
	definition: Omit<
		ModuleSettingDefinition,
		'visibility' | 'client' | 'scope' | 'labelKey' | 'descriptionKey'
	>,
): ModuleSettingDefinition {
	return {
		...definition,
		visibility: 'private',
		client: false,
		scope: 'tenant',
		labelKey: `research.settings.${key}.label`,
		descriptionKey: `research.settings.${key}.description`,
	};
}

/** The flat setting key prefix of an adapter: `model-native` is `modelNative`. */
export function adapterSettingPrefix(key: ResearchChainAdapterKey): string {
	return key.replace(/-([a-z])/g, (_match, letter: string) =>
		letter.toUpperCase(),
	);
}

const ADAPTER_LABELS: Readonly<Record<ResearchChainAdapterKey, string>> = {
	'model-native': 'Model-native',
	searxng: 'SearXNG',
	firecrawl: 'Firecrawl',
	connector: 'Connector',
	recorded: 'Recorded',
	direct: 'Direct fetch',
};

function adapterSettings(): Record<string, ModuleSettingDefinition> {
	const definitions: Record<string, ModuleSettingDefinition> = {};
	for (const key of RESEARCH_ADAPTERS) {
		const prefix = adapterSettingPrefix(key);
		definitions[`${prefix}Enabled`] = setting(`${prefix}Enabled`, {
			type: 'boolean',
			defaultValue: key === 'model-native',
			label: `${ADAPTER_LABELS[key]} enabled`,
			description: `Whether ${key} takes part in the search chain.`,
		});
	}
	for (const key of [...RESEARCH_ADAPTERS, 'direct'] as const) {
		const prefix = adapterSettingPrefix(key);
		definitions[`${prefix}MaxAttempts`] = setting(`${prefix}MaxAttempts`, {
			type: 'number',
			defaultValue: RESEARCH_CHAIN_LIMITS.maxAttemptsDefault,
			min: RESEARCH_CHAIN_LIMITS.maxAttemptsMin,
			max: RESEARCH_CHAIN_LIMITS.maxAttemptsMax,
			label: `${ADAPTER_LABELS[key]} attempts`,
			description: `How many times ${key} is tried for one query or page.`,
		});
	}
	for (const key of RESEARCH_ADAPTERS) {
		const prefix = adapterSettingPrefix(key);
		definitions[`${prefix}TimeoutMs`] = setting(`${prefix}TimeoutMs`, {
			type: 'number',
			defaultValue: RESEARCH_CHAIN_LIMITS.timeoutDefaultMs,
			min: RESEARCH_CHAIN_LIMITS.timeoutMinMs,
			max: RESEARCH_CHAIN_LIMITS.timeoutMaxMs,
			label: `${ADAPTER_LABELS[key]} timeout (milliseconds)`,
			description: `How long one attempt of ${key} may take.`,
		});
	}
	return definitions;
}

export const RESEARCH_MODULE_SETTINGS = defineModuleSettings({
	moduleId: RESEARCH_MODULE_ID,
	settings: {
		adapter: setting('adapter', {
			type: 'string',
			defaultValue: 'model-native',
			enum: RESEARCH_ADAPTERS,
			label: 'Search adapter',
			description:
				'The one adapter that answers while the search order is empty: model-native lets the model provider search inside an agent run, searxng and firecrawl call their providers, connector calls a connectors instance, recorded answers from a fixtures file.',
		}),
		searchOrder: setting('searchOrder', {
			type: 'string',
			defaultValue: '',
			max: 200,
			label: 'Search order',
			description:
				'Comma separated search adapter keys in the order the chain tries them. Empty keeps the single search adapter.',
		}),
		fetchOrder: setting('fetchOrder', {
			type: 'string',
			defaultValue: 'direct',
			max: 100,
			label: 'Fetch order',
			description:
				'Comma separated fetch adapter keys, direct and firecrawl, in the order a page read tries them.',
		}),
		fallback: setting('fallback', {
			type: 'string',
			defaultValue: 'next-adapter',
			enum: RESEARCH_FALLBACK_MODES,
			label: 'Fallback',
			description:
				'next-adapter hands a query an adapter could not answer to the next one; fail answers that failure.',
		}),
		fallbackOnEmpty: setting('fallbackOnEmpty', {
			type: 'boolean',
			defaultValue: true,
			label: 'Fall back on empty results',
			description:
				'Move on to the next adapter when an adapter answers without any admitted result.',
		}),
		retryBackoffMs: setting('retryBackoffMs', {
			type: 'number',
			defaultValue: RESEARCH_CHAIN_LIMITS.backoffDefaultMs,
			min: 0,
			max: RESEARCH_CHAIN_LIMITS.backoffMaxMs,
			label: 'Retry backoff (milliseconds)',
			description:
				'Base of the random retry delay, doubled per retry and capped at 5000.',
		}),
		circuitFailureThreshold: setting('circuitFailureThreshold', {
			type: 'number',
			defaultValue: RESEARCH_CHAIN_LIMITS.thresholdDefault,
			min: RESEARCH_CHAIN_LIMITS.thresholdMin,
			max: RESEARCH_CHAIN_LIMITS.thresholdMax,
			label: 'Circuit failure threshold',
			description:
				'Consecutive failed queries after which an adapter is paused.',
		}),
		circuitCooldownMs: setting('circuitCooldownMs', {
			type: 'number',
			defaultValue: RESEARCH_CHAIN_LIMITS.cooldownDefaultMs,
			min: RESEARCH_CHAIN_LIMITS.cooldownMinMs,
			max: RESEARCH_CHAIN_LIMITS.cooldownMaxMs,
			label: 'Circuit cooldown (milliseconds)',
			description:
				'How long a paused adapter is skipped before one query tries it again.',
		}),
		...adapterSettings(),
		connectorInstanceId: setting('connectorInstanceId', {
			type: 'string',
			defaultValue: '',
			max: 128,
			label: 'Connector instance',
			description:
				'The id of the connectors instance the connector adapter calls with operation search.',
		}),
		recordedFixturesPath: setting('recordedFixturesPath', {
			type: 'string',
			defaultValue: '',
			max: 1_024,
			label: 'Recorded fixtures file',
			description:
				'The absolute path, or a path relative to the workspace root, of the research-fixtures.json file the recorded adapter reads.',
		}),
		allowDomains: setting('allowDomains', {
			type: 'string',
			defaultValue: '',
			max: 4_000,
			label: 'Allowed domains',
			description:
				'Comma separated host names a result or a fetch may reach, subdomains included. Empty admits every host the denied list leaves.',
		}),
		denyDomains: setting('denyDomains', {
			type: 'string',
			defaultValue: '',
			max: 4_000,
			label: 'Denied domains',
			description:
				'Comma separated host names no result or fetch may reach, subdomains included.',
		}),
		monthlyQueryBudget: setting('monthlyQueryBudget', {
			type: 'number',
			defaultValue: 500,
			min: 0,
			max: RESEARCH_LIMITS.budgetMax,
			label: 'Monthly query budget',
			description: 'Searches the workspace may make in one UTC calendar month.',
		}),
		storeFullText: setting('storeFullText', {
			type: 'boolean',
			defaultValue: false,
			label: 'Store full page text',
			description:
				'Keep the whole text of a fetched page with its evidence. Off keeps the sha256 and a 4 KB excerpt only.',
		}),
		fetchMaxBytes: setting('fetchMaxBytes', {
			type: 'number',
			defaultValue: 2_000_000,
			min: 1_024,
			max: 2_000_000,
			label: 'Page size cap (bytes)',
			description: 'Bytes of one page read before the fetch is refused.',
		}),
		fetchTimeoutMs: setting('fetchTimeoutMs', {
			type: 'number',
			defaultValue: 20_000,
			min: 1_000,
			max: 20_000,
			label: 'Page timeout (milliseconds)',
			description: 'How long one fetch may take before it is refused.',
		}),
		allowAgents: setting('allowAgents', {
			type: 'boolean',
			defaultValue: false,
			label: 'Allow agents',
			description:
				'Let agent runs search and read pages through the research tools and the native web search.',
		}),
	},
});

const HOST =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Host names of a comma separated list, lower-cased, with a leading `*.` or `.` dropped. */
export function domainList(value: string): readonly string[] {
	return [
		...new Set(
			value
				.split(',')
				.map((entry) =>
					entry
						.trim()
						.toLowerCase()
						.replace(/^\*?\./, ''),
				)
				.filter((entry) => entry.length <= 253 && HOST.test(entry)),
		),
	];
}

/** Known keys of a comma separated order, first occurrence kept, anything else dropped. */
export function adapterOrder<Key extends string>(
	value: string,
	known: readonly Key[],
): readonly Key[] {
	const seen = new Set<Key>();
	for (const entry of value.split(',')) {
		const key = entry.trim() as Key;
		if (known.includes(key)) seen.add(key);
	}
	return [...seen];
}

/** Settings are read live, after the tenant is primed, so a change applies to the next call. */
export async function readResearchSettings(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): Promise<ResearchSettings> {
	await settings.prime(tenantId);
	const get = <T extends string | number | boolean>(key: string): T =>
		settings.get<T>(tenantId, RESEARCH_MODULE_ID, key);
	const fetchOrder = adapterOrder<ResearchFetchAdapterKey>(
		get<string>('fetchOrder'),
		RESEARCH_FETCH_ADAPTERS,
	);
	const limits = {} as Record<ResearchChainAdapterKey, ResearchAdapterLimits>;
	for (const key of RESEARCH_ADAPTERS) {
		const prefix = adapterSettingPrefix(key);
		limits[key] = {
			enabled: get<boolean>(`${prefix}Enabled`),
			maxAttempts: get<number>(`${prefix}MaxAttempts`),
			timeoutMs: get<number>(`${prefix}TimeoutMs`),
		};
	}
	limits.direct = {
		enabled: fetchOrder.includes('direct'),
		maxAttempts: get<number>('directMaxAttempts'),
		timeoutMs: get<number>('fetchTimeoutMs'),
	};
	return {
		adapter: get<string>('adapter') as ResearchAdapterKey,
		searchOrder: adapterOrder<ResearchAdapterKey>(
			get<string>('searchOrder'),
			RESEARCH_ADAPTERS,
		),
		fetchOrder: fetchOrder.length === 0 ? ['direct'] : fetchOrder,
		fallback: get<string>('fallback') as ResearchFallbackMode,
		fallbackOnEmpty: get<boolean>('fallbackOnEmpty'),
		retryBackoffMs: get<number>('retryBackoffMs'),
		circuitFailureThreshold: get<number>('circuitFailureThreshold'),
		circuitCooldownMs: get<number>('circuitCooldownMs'),
		limits,
		connectorInstanceId: get<string>('connectorInstanceId'),
		recordedFixturesPath: get<string>('recordedFixturesPath'),
		allowDomains: domainList(get<string>('allowDomains')),
		denyDomains: domainList(get<string>('denyDomains')),
		monthlyQueryBudget: get<number>('monthlyQueryBudget'),
		storeFullText: get<boolean>('storeFullText'),
		fetchMaxBytes: get<number>('fetchMaxBytes'),
		fetchTimeoutMs: get<number>('fetchTimeoutMs'),
		allowAgents: get<boolean>('allowAgents'),
	};
}
