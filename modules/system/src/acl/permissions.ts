export const SYSTEM_PERMISSIONS = {
	workspaceAccess: 'system.workspace.access',
	modulesRead: 'system.modules.read',
	specsRead: 'system.specs.read',
	runsRead: 'system.runs.read',
	settingsRead: 'system.settings.read',
	settingsManage: 'system.settings.manage',
} as const;

export const permissions = Object.freeze(Object.values(SYSTEM_PERMISSIONS));
