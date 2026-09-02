import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsDeclaration,
	type ModuleSettingsRuntime,
} from '@coreloom/kernel';

export const AUTOMATIONS_MODULE_ID = 'automations.core';

export const AUTOMATIONS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: AUTOMATIONS_MODULE_ID,
	settings: {
		schedulerPollMs: {
			type: 'number',
			defaultValue: 30_000,
			min: 1_000,
			max: 300_000,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'automations.settings.schedulerPollMs.label',
			label: 'Scheduler poll interval (ms)',
			descriptionKey: 'automations.settings.schedulerPollMs.description',
			description:
				'How often this process checks for due schedules. Applied when the automations runtime starts.',
		},
	},
});

function environmentPollMs(environment: NodeJS.ProcessEnv): number {
	const raw = environment.CL_AUTOMATIONS_SCHEDULER_POLL_MS;
	if (raw === undefined) return 30_000;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
		throw new Error(
			'CL_AUTOMATIONS_SCHEDULER_POLL_MS must be an integer between 1000 and 300000.',
		);
	}
	return value;
}

export function automationsModuleSettingsFromEnvironment(
	environment: NodeJS.ProcessEnv,
): ModuleSettingsDeclaration {
	return defineModuleSettings({
		moduleId: AUTOMATIONS_MODULE_ID,
		settings: {
			schedulerPollMs: {
				...AUTOMATIONS_MODULE_SETTINGS.settings.schedulerPollMs!,
				defaultValue: environmentPollMs(environment),
			},
		},
	});
}

export function automationsSchedulerPollMs(
	settings: ModuleSettingsRuntime,
	environment: NodeJS.ProcessEnv,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			AUTOMATIONS_MODULE_ID,
			'schedulerPollMs',
		);
	} catch {
		return environmentPollMs(environment);
	}
}
