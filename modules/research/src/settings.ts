import {
	defineModuleSettings,
	type ModuleSettingDefinition,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import {
	RESEARCH_ADAPTERS,
	RESEARCH_LIMITS,
	RESEARCH_MODULE_ID,
	type ResearchAdapterKey,
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

export const RESEARCH_MODULE_SETTINGS = defineModuleSettings({
	moduleId: RESEARCH_MODULE_ID,
	settings: {
		adapter: setting('adapter', {
			type: 'string',
			defaultValue: 'model-native',
			enum: RESEARCH_ADAPTERS,
			label: 'Search adapter',
			description:
				'model-native lets the model provider search inside an agent run, connector calls a connectors instance, recorded answers from a fixtures file.',
		}),
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

/** Settings are read live, after the tenant is primed, so a change applies to the next call. */
export async function readResearchSettings(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): Promise<ResearchSettings> {
	await settings.prime(tenantId);
	const get = <T extends string | number | boolean>(key: string): T =>
		settings.get<T>(tenantId, RESEARCH_MODULE_ID, key);
	return {
		adapter: get<string>('adapter') as ResearchAdapterKey,
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
