import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import type { ConnectorCallLimits } from './services/call-service.ts';

export const CONNECTORS_MODULE_ID = 'connectors.core';

export const CONNECTORS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: CONNECTORS_MODULE_ID,
	settings: {
		callTimeoutMs: {
			type: 'number',
			defaultValue: 10_000,
			min: 1_000,
			max: 60_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'connectors.settings.callTimeoutMs.label',
			label: 'Call timeout (milliseconds)',
			descriptionKey: 'connectors.settings.callTimeoutMs.description',
			description:
				'How long one connector call may take before it is aborted and recorded as a timeout.',
		},
		maxResponseBytes: {
			type: 'number',
			defaultValue: 1_048_576,
			min: 1_024,
			max: 16_777_216,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'connectors.settings.maxResponseBytes.label',
			label: 'Response size cap (bytes)',
			descriptionKey: 'connectors.settings.maxResponseBytes.description',
			description:
				'Bytes of a response that are read before the call is recorded as too large.',
		},
	},
});

/* A setting read must never take a call down, so each accessor falls back to
   the declared default when the runtime has not registered it yet. */
function value(
	settings: ModuleSettingsRuntime,
	key: 'callTimeoutMs' | 'maxResponseBytes',
	fallback: number,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			CONNECTORS_MODULE_ID,
			key,
		);
	} catch {
		return fallback;
	}
}

export function connectorCallLimits(
	settings: ModuleSettingsRuntime,
): ConnectorCallLimits {
	return {
		timeoutMs: value(settings, 'callTimeoutMs', 10_000),
		maxResponseBytes: value(settings, 'maxResponseBytes', 1_048_576),
	};
}
