import { defineModuleSettings } from '@flowdular/kernel';
import {
	DEFAULT_TIME_ZONE,
	MAX_TIME_ZONE_LENGTH,
	SYSTEM_MODULE_ID,
	TIME_ZONE_PATTERN,
} from './domain/time-zone.ts';

export const SYSTEM_MODULE_SETTINGS = defineModuleSettings({
	moduleId: SYSTEM_MODULE_ID,
	settings: {
		timeZone: {
			type: 'string',
			defaultValue: DEFAULT_TIME_ZONE,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			min: 1,
			max: MAX_TIME_ZONE_LENGTH,
			pattern: TIME_ZONE_PATTERN,
			labelKey: 'system.settings.timeZone.label',
			label: 'Workspace time zone',
			descriptionKey: 'system.settings.timeZone.description',
			description:
				'IANA zone name such as Europe/Warsaw. Modules that show or schedule local times read it; the default is UTC.',
		},
	},
});
