import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import {
	PROVIDER_TIMEOUT_RANGE,
	type ReportsBudget,
} from './services/reports-service.ts';

export const REPORTS_MODULE_ID = 'reports.core';

const DEFAULT_PROVIDER_TIMEOUT_MS = 3_000;

export const REPORTS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: REPORTS_MODULE_ID,
	settings: {
		providerTimeoutMs: {
			type: 'number',
			defaultValue: DEFAULT_PROVIDER_TIMEOUT_MS,
			min: PROVIDER_TIMEOUT_RANGE.minimum,
			max: PROVIDER_TIMEOUT_RANGE.maximum,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'reports.settings.providerTimeoutMs.label',
			label: 'Provider time budget (ms)',
			descriptionKey: 'reports.settings.providerTimeoutMs.description',
			description:
				'Time one provider gets per request before it is reported unavailable.',
		},
	},
});

/* A settings read must never take a request down, so the accessor falls back to
   the declared default when the runtime has not registered it yet. */
export function reportsBudget(settings: ModuleSettingsRuntime): ReportsBudget {
	try {
		return {
			providerTimeoutMs: settings.get<number>(
				PLATFORM_SETTINGS_TENANT,
				REPORTS_MODULE_ID,
				'providerTimeoutMs',
			),
		};
	} catch {
		return { providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS };
	}
}
