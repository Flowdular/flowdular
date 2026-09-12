import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';

export const DIRECTORY_MODULE_ID = 'directory.core';

export const DIRECTORY_DEFAULT_ROLE = 'member';
export const DIRECTORY_DEFAULT_PAGE_SIZE_MAX = 200;

export const DIRECTORY_MODULE_SETTINGS = defineModuleSettings({
	moduleId: DIRECTORY_MODULE_ID,
	settings: {
		defaultRole: {
			type: 'string',
			defaultValue: DIRECTORY_DEFAULT_ROLE,
			max: 32,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'directory.settings.defaultRole.label',
			label: 'Default provisioned role',
			descriptionKey: 'directory.settings.defaultRole.description',
			description:
				'The workspace role a provisioned user receives when no mapped group applies. It is checked against the workspace roles at the moment it is used.',
		},
		pageSizeMax: {
			type: 'number',
			defaultValue: DIRECTORY_DEFAULT_PAGE_SIZE_MAX,
			min: 1,
			max: 1_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'directory.settings.pageSizeMax.label',
			label: 'Maximum SCIM page size',
			descriptionKey: 'directory.settings.pageSizeMax.description',
			description:
				'Upper bound of the SCIM count parameter. A larger request is clamped to this value rather than refused.',
		},
	},
});

/* A setting read must never take a SCIM request down, so each accessor falls
   back to the declared default when the runtime has not registered it yet. */
function value<T extends string | number>(
	settings: ModuleSettingsRuntime,
	tenantId: string,
	key: 'defaultRole' | 'pageSizeMax',
	fallback: T,
): T {
	try {
		return settings.get<T>(tenantId, DIRECTORY_MODULE_ID, key);
	} catch {
		return fallback;
	}
}

export function directoryDefaultRole(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): string {
	const stored = value(
		settings,
		tenantId,
		'defaultRole',
		DIRECTORY_DEFAULT_ROLE,
	)
		.trim()
		.toLowerCase();
	return stored === '' ? DIRECTORY_DEFAULT_ROLE : stored;
}

export function directoryPageSizeMax(settings: ModuleSettingsRuntime): number {
	const stored = value(
		settings,
		PLATFORM_SETTINGS_TENANT,
		'pageSizeMax',
		DIRECTORY_DEFAULT_PAGE_SIZE_MAX,
	);
	if (!Number.isSafeInteger(stored) || stored < 1) {
		return DIRECTORY_DEFAULT_PAGE_SIZE_MAX;
	}
	return Math.min(stored, 1_000);
}
