import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import { WARNING_PERCENT_RANGE } from './services/metering-service.ts';

export const METERING_MODULE_ID = 'metering.core';

/** The share of a limit the owners are notified at, before it refuses. */
export const DEFAULT_WARNING_PERCENT = 80;

export const METERING_MODULE_SETTINGS = defineModuleSettings({
	moduleId: METERING_MODULE_ID,
	settings: {
		warningPercent: {
			type: 'number',
			defaultValue: DEFAULT_WARNING_PERCENT,
			min: WARNING_PERCENT_RANGE.minimum,
			max: WARNING_PERCENT_RANGE.maximum,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'metering.settings.warningPercent.label',
			label: 'Warning share of a limit (percent)',
			descriptionKey: 'metering.settings.warningPercent.description',
			description:
				'Share of a monthly limit at which the workspace owners are notified, before the limit itself refuses.',
		},
	},
});

/* A setting read must never take a recording path down, so the accessor falls
   back to the declared default when the runtime has not registered it yet. */
export function meteringWarningPercent(
	settings: ModuleSettingsRuntime,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			METERING_MODULE_ID,
			'warningPercent',
		);
	} catch {
		return DEFAULT_WARNING_PERCENT;
	}
}
