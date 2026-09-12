import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';

export const IMPORT_MODULE_ID = 'import.core';

export const DEFAULT_IMPORT_MAX_ROWS = 50_000;
export const DEFAULT_IMPORT_BATCH_SIZE = 500;

export const IMPORT_MODULE_SETTINGS = defineModuleSettings({
	moduleId: IMPORT_MODULE_ID,
	settings: {
		maxRows: {
			type: 'number',
			defaultValue: DEFAULT_IMPORT_MAX_ROWS,
			min: 100,
			max: 500_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'import.settings.maxRows.label',
			label: 'Rows per job',
			descriptionKey: 'import.settings.maxRows.description',
			description: 'Rows one import job may hold; a larger file is refused.',
		},
		batchSize: {
			type: 'number',
			defaultValue: DEFAULT_IMPORT_BATCH_SIZE,
			min: 50,
			max: 5_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'import.settings.batchSize.label',
			label: 'Rows per batch',
			descriptionKey: 'import.settings.batchSize.description',
			description:
				'Rows handed to an import port in one validate or write call.',
		},
	},
});

/* A setting read must never take a running job down, so both accessors fall
   back to the declared default when the runtime has not registered the module
   yet. */
function value(
	settings: ModuleSettingsRuntime,
	key: 'maxRows' | 'batchSize',
	fallback: number,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			IMPORT_MODULE_ID,
			key,
		);
	} catch {
		return fallback;
	}
}

export function importMaxRows(settings: ModuleSettingsRuntime): number {
	return value(settings, 'maxRows', DEFAULT_IMPORT_MAX_ROWS);
}

export function importBatchSize(settings: ModuleSettingsRuntime): number {
	return value(settings, 'batchSize', DEFAULT_IMPORT_BATCH_SIZE);
}
