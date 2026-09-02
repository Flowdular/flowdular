export const AUTOMATIONS_PERMISSIONS = {
	read: 'automations.schedules.read',
	manage: 'automations.schedules.manage',
	triggersRead: 'automations.triggers.read',
	triggersManage: 'automations.triggers.manage',
} as const;

export const permissions = Object.freeze(
	Object.values(AUTOMATIONS_PERMISSIONS),
);
