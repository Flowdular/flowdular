import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';

export const AUDIT_MODULE_ID = 'audit.core';

export const AUDIT_MODULE_SETTINGS = defineModuleSettings({
	moduleId: AUDIT_MODULE_ID,
	settings: {
		sweepIntervalMinutes: {
			type: 'number',
			defaultValue: 60,
			min: 5,
			max: 1_440,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'audit.settings.sweepIntervalMinutes.label',
			label: 'Retention sweep interval (minutes)',
			descriptionKey: 'audit.settings.sweepIntervalMinutes.description',
			/* The loop arms its interval once, in the platform's start hook, so a
			   value edited while it runs reaches it at the next start. The
			   description says so rather than leaving an operator watching a
			   cadence that did not change. */
			description:
				'How often the retention sweep looks for classes whose period has passed. A new value applies the next time the platform starts.',
		},
		sweepBatchSize: {
			type: 'number',
			defaultValue: 500,
			min: 50,
			max: 5_000,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'audit.settings.sweepBatchSize.label',
			label: 'Retention sweep batch size',
			descriptionKey: 'audit.settings.sweepBatchSize.description',
			description:
				'Rows the owning module removes per call, per class, until fewer than this come back.',
		},
	},
});

const DEFAULTS = AUDIT_MODULE_SETTINGS.settings;

/* A setting read must never take the sweep down, so every accessor falls back
   to the declared default when the runtime has not registered it yet. */
function value(
	settings: ModuleSettingsRuntime,
	key: keyof typeof DEFAULTS,
	fallback: number,
): number {
	try {
		return settings.get<number>(PLATFORM_SETTINGS_TENANT, AUDIT_MODULE_ID, key);
	} catch {
		return fallback;
	}
}

export function auditSweepIntervalMs(settings: ModuleSettingsRuntime): number {
	return value(settings, 'sweepIntervalMinutes', 60) * 60_000;
}

export function auditSweepBatchSize(settings: ModuleSettingsRuntime): number {
	return value(settings, 'sweepBatchSize', 500);
}
