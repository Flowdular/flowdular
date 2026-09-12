import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import type { TenantDeliverySettings } from './services/delivery-service.ts';

export const NOTIFICATIONS_MODULE_ID = 'notifications.core';

export const NOTIFICATIONS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: NOTIFICATIONS_MODULE_ID,
	settings: {
		retentionDays: {
			type: 'number',
			defaultValue: 30,
			min: 1,
			max: 365,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'notifications.settings.retentionDays.label',
			label: 'Delivery retention (days)',
			descriptionKey: 'notifications.settings.retentionDays.description',
			description:
				'Days a delivery attempt is kept before the delivery loop deletes it.',
		},
		retryMaxAttempts: {
			type: 'number',
			defaultValue: 8,
			min: 1,
			max: 20,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'notifications.settings.retryMaxAttempts.label',
			label: 'Maximum delivery attempts',
			descriptionKey: 'notifications.settings.retryMaxAttempts.description',
			description: 'Attempts made before a delivery moves to the dead letter.',
		},
		retryMaxBackoffMinutes: {
			type: 'number',
			defaultValue: 360,
			min: 1,
			max: 1_440,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'notifications.settings.retryMaxBackoffMinutes.label',
			label: 'Maximum retry backoff (minutes)',
			descriptionKey:
				'notifications.settings.retryMaxBackoffMinutes.description',
			description:
				'Upper bound of the exponential wait between delivery attempts.',
		},
		egressAllowlist: {
			type: 'string',
			defaultValue: '',
			max: 4_096,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'notifications.settings.egressAllowlist.label',
			label: 'Webhook host allowlist',
			descriptionKey: 'notifications.settings.egressAllowlist.description',
			description:
				'Comma-separated host names a subscription URL may use. Empty means any public host that passes the private-range block.',
		},
		pollIntervalSeconds: {
			type: 'number',
			defaultValue: 15,
			min: 5,
			max: 300,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'notifications.settings.pollIntervalSeconds.label',
			label: 'Delivery poll interval (seconds)',
			descriptionKey: 'notifications.settings.pollIntervalSeconds.description',
			description:
				'How often the delivery loop looks for due attempts. Applied when the notifications runtime starts.',
		},
	},
});

const DEFAULTS = NOTIFICATIONS_MODULE_SETTINGS.settings;

/* A setting read must never take a running loop down, so every accessor falls
   back to the declared default when the runtime has not registered it yet. */
function value<T extends string | number>(
	settings: ModuleSettingsRuntime,
	tenantId: string,
	key: keyof typeof DEFAULTS,
	fallback: T,
): T {
	try {
		return settings.get<T>(tenantId, NOTIFICATIONS_MODULE_ID, key);
	} catch {
		return fallback;
	}
}

export function notificationsDeliverySettings(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): TenantDeliverySettings {
	return {
		retentionDays: value(settings, tenantId, 'retentionDays', 30),
		retryMaxAttempts: value(settings, tenantId, 'retryMaxAttempts', 8),
		retryMaxBackoffMinutes: value(
			settings,
			tenantId,
			'retryMaxBackoffMinutes',
			360,
		),
	};
}

export function notificationsEgressAllowlist(
	settings: ModuleSettingsRuntime,
): string {
	return value(settings, PLATFORM_SETTINGS_TENANT, 'egressAllowlist', '');
}

export function notificationsPollIntervalMs(
	settings: ModuleSettingsRuntime,
): number {
	return (
		value(settings, PLATFORM_SETTINGS_TENANT, 'pollIntervalSeconds', 15) * 1_000
	);
}
