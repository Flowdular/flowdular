import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { AUTOMATIONS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'automations.navigation.schedules',
			label: 'Schedules',
			href: '/automation-schedules',
			order: 10,
			permission: AUTOMATIONS_PERMISSIONS.read,
		},
		{
			id: 'automations.navigation.triggers',
			label: 'Webhook triggers',
			href: '/automation-triggers',
			order: 20,
			permission: AUTOMATIONS_PERMISSIONS.triggersRead,
		},
	],
	permissions: Object.values(AUTOMATIONS_PERMISSIONS),
} satisfies RegisteredModule;

export { AUTOMATIONS_PERMISSIONS } from './acl/permissions.ts';
export { AUTOMATIONS_MODULE_SETTINGS } from './settings.ts';
export { AutomationsServiceError } from './services/automations-service.ts';
export type {
	AutomationAgent,
	AutomationSchedule,
	AutomationTargetOption,
	AutomationTrigger,
	AutomationTriggerSecret,
	CreateAutomationScheduleInput,
	CreateAutomationTriggerInput,
	UpdateAutomationScheduleInput,
	UpdateAutomationTriggerInput,
} from './domain/types.ts';
