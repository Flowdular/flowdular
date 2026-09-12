import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';

export const APPROVALS_MODULE_ID = 'approvals.core';

export const APPROVALS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: APPROVALS_MODULE_ID,
	settings: {
		defaultExpiryDays: {
			type: 'number',
			defaultValue: 7,
			min: 1,
			max: 90,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'approvals.settings.defaultExpiryDays.label',
			label: 'Default expiry (days)',
			descriptionKey: 'approvals.settings.defaultExpiryDays.description',
			description:
				'Days a request stays open when the requirement names no expiry of its own.',
		},
		expiryIntervalMinutes: {
			type: 'number',
			defaultValue: 15,
			min: 1,
			max: 1_440,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'approvals.settings.expiryIntervalMinutes.label',
			label: 'Expiry loop interval (minutes)',
			descriptionKey: 'approvals.settings.expiryIntervalMinutes.description',
			description:
				'How often the expiry loop looks for due requests. Applied when the approvals runtime starts.',
		},
	},
});

const DEFAULTS = APPROVALS_MODULE_SETTINGS.settings;

/* A setting read must never take a running loop down, so every accessor falls
   back to the declared default when the runtime has not registered it yet. */
function value(
	settings: ModuleSettingsRuntime,
	tenantId: string,
	key: keyof typeof DEFAULTS,
	fallback: number,
): number {
	try {
		return settings.get<number>(tenantId, APPROVALS_MODULE_ID, key);
	} catch {
		return fallback;
	}
}

export function approvalsDefaultExpiryDays(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): number {
	return value(settings, tenantId, 'defaultExpiryDays', 7);
}

export function approvalsExpiryIntervalMs(
	settings: ModuleSettingsRuntime,
): number {
	return (
		value(settings, PLATFORM_SETTINGS_TENANT, 'expiryIntervalMinutes', 15) *
		60 *
		1_000
	);
}
