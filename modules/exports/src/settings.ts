import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';

export const EXPORTS_MODULE_ID = 'exports.core';

export const DEFAULT_EXPORT_MAX_ROWS = 100_000;
export const DEFAULT_EXPORT_MAX_BYTES = 50 * 1024 * 1024;

export const EXPORTS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: EXPORTS_MODULE_ID,
	settings: {
		maxRows: {
			type: 'number',
			defaultValue: DEFAULT_EXPORT_MAX_ROWS,
			min: 100,
			max: 5_000_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'exports.settings.maxRows.label',
			label: 'Rows per export',
			descriptionKey: 'exports.settings.maxRows.description',
			description: 'Rows one export may hold; a longer list fails instead.',
		},
		maxBytes: {
			type: 'number',
			defaultValue: DEFAULT_EXPORT_MAX_BYTES,
			min: 1_024,
			max: 268_435_456,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'exports.settings.maxBytes.label',
			label: 'Bytes per export',
			descriptionKey: 'exports.settings.maxBytes.description',
			description:
				'Bytes one export may hold; the storage object limit still applies.',
		},
	},
});

/* A setting read must never take a running job down, so both accessors fall
   back to the declared default when the runtime has not registered the module
   yet. */
function value(
	settings: ModuleSettingsRuntime,
	key: 'maxRows' | 'maxBytes',
	fallback: number,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			EXPORTS_MODULE_ID,
			key,
		);
	} catch {
		return fallback;
	}
}

export function exportMaxRows(settings: ModuleSettingsRuntime): number {
	return value(settings, 'maxRows', DEFAULT_EXPORT_MAX_ROWS);
}

export function exportMaxBytes(settings: ModuleSettingsRuntime): number {
	return value(settings, 'maxBytes', DEFAULT_EXPORT_MAX_BYTES);
}
