import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsDeclaration,
	type ModuleSettingsRuntime,
	type ModuleSettingValue,
} from '@coreloom/kernel';
import { providerHostAllowlist } from './services/outbound-policy.ts';
import { agentRuntimeOptionsFromEnvironment } from './server/runtime.ts';

export const AGENTS_MODULE_ID = 'agents.core';

export const AGENTS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: AGENTS_MODULE_ID,
	settings: {
		workerConcurrency: {
			type: 'number',
			defaultValue: 2,
			min: 1,
			max: 16,
			visibility: 'private',
			client: false,
			scope: 'platform',
			label: 'Worker concurrency',
			description:
				'Runs one process executes at the same time. Applied at the next queue drain.',
		},
		workerLeaseMs: {
			type: 'number',
			defaultValue: 30_000,
			min: 1_000,
			max: 300_000,
			visibility: 'private',
			client: false,
			scope: 'platform',
			label: 'Worker lease (ms)',
			description:
				'How long a claimed run stays owned by a worker before another worker may recover it. Applied to new claims.',
		},
		providerReadinessTtlMs: {
			type: 'number',
			defaultValue: 86_400_000,
			min: 10_000,
			max: 86_400_000,
			visibility: 'private',
			client: false,
			scope: 'platform',
			label: 'Model readiness validity (ms)',
			description:
				'How long a successful model test or run counts as proof that the model answers.',
		},
		providerHostAllowlist: {
			type: 'string',
			defaultValue: '',
			max: 4_096,
			visibility: 'private',
			client: false,
			scope: 'platform',
			label: 'OpenAI-compatible host allowlist',
			description:
				'Comma-separated public HTTPS hostnames an OpenAI-compatible connection may target.',
		},
		defaultMaxOutputTokens: {
			type: 'number',
			defaultValue: 4_096,
			min: 256,
			max: 65_536,
			visibility: 'private',
			client: false,
			scope: 'tenant',
			label: 'Default output budget (tokens)',
			description: 'Used when an agent definition does not set its own.',
		},
		defaultProvider: {
			type: 'string',
			defaultValue: '',
			max: 128,
			visibility: 'private',
			client: false,
			scope: 'tenant',
			label: 'Default provider connection',
			description:
				'Provider connection id preselected for new agents. Empty means none.',
		},
		defaultModel: {
			type: 'string',
			defaultValue: '',
			max: 160,
			visibility: 'private',
			client: false,
			scope: 'tenant',
			label: 'Default model',
			description: 'Model id preselected for new agents. Empty means none.',
		},
	},
});

/* The deployment's environment is the declared default an admin sees and
   overrides, so the same declaration is rebuilt with those values at boot. */
export function agentsModuleSettingsFromEnvironment(
	environment: NodeJS.ProcessEnv,
): ModuleSettingsDeclaration {
	const options = agentRuntimeOptionsFromEnvironment(environment);
	const defaults: Record<string, ModuleSettingValue> = {
		workerConcurrency: options.workerConcurrency,
		workerLeaseMs: options.workerLeaseMs,
		providerReadinessTtlMs: options.providerReadinessTtlMs,
		providerHostAllowlist:
			environment.OERP_AGENT_PROVIDER_HOST_ALLOWLIST?.trim() ?? '',
	};
	return defineModuleSettings({
		moduleId: AGENTS_MODULE_ID,
		settings: Object.fromEntries(
			Object.entries(AGENTS_MODULE_SETTINGS.settings).map(
				([key, definition]) => [
					key,
					key in defaults
						? { ...definition, defaultValue: defaults[key]! }
						: definition,
				],
			),
		),
	});
}

export interface AgentSettingsReader {
	workerConcurrency(): number;
	workerLeaseMs(): number;
	providerReadinessTtlMs(): number;
	providerHostAllowlist(): ReadonlySet<string>;
	defaultMaxOutputTokens(tenantId: string): number;
	defaultProvider(tenantId: string): string;
	defaultModel(tenantId: string): string;
}

function settingsSource(value: unknown): ModuleSettingsRuntime | null {
	return value &&
		typeof value === 'object' &&
		typeof (value as ModuleSettingsRuntime).get === 'function'
		? (value as ModuleSettingsRuntime)
		: null;
}

/* Reads are live and per call. Without a settings runtime, or when a read
   fails, the environment decides exactly as before. */
export function agentSettings(context: {
	readonly environment: NodeJS.ProcessEnv;
	readonly settings?: unknown;
}): AgentSettingsReader {
	const fallback = agentRuntimeOptionsFromEnvironment(context.environment);
	const source = settingsSource(context.settings);
	const read = <T extends ModuleSettingValue>(
		tenantId: string,
		key: keyof typeof AGENTS_MODULE_SETTINGS.settings,
		fallbackValue: T,
	): T => {
		if (!source) return fallbackValue;
		try {
			const value: unknown = source.get(tenantId, AGENTS_MODULE_ID, key);
			return typeof value === typeof fallbackValue
				? (value as T)
				: fallbackValue;
		} catch {
			return fallbackValue;
		}
	};
	return {
		workerConcurrency: () =>
			read(
				PLATFORM_SETTINGS_TENANT,
				'workerConcurrency',
				fallback.workerConcurrency,
			),
		workerLeaseMs: () =>
			read(PLATFORM_SETTINGS_TENANT, 'workerLeaseMs', fallback.workerLeaseMs),
		providerReadinessTtlMs: () =>
			read(
				PLATFORM_SETTINGS_TENANT,
				'providerReadinessTtlMs',
				fallback.providerReadinessTtlMs,
			),
		providerHostAllowlist: () =>
			source
				? providerHostAllowlist(
						read(
							PLATFORM_SETTINGS_TENANT,
							'providerHostAllowlist',
							context.environment.OERP_AGENT_PROVIDER_HOST_ALLOWLIST ?? '',
						),
					)
				: fallback.providerHostAllowlist,
		defaultMaxOutputTokens: (tenantId) =>
			read(tenantId, 'defaultMaxOutputTokens', 4_096),
		defaultProvider: (tenantId) => read(tenantId, 'defaultProvider', ''),
		defaultModel: (tenantId) => read(tenantId, 'defaultModel', ''),
	};
}
