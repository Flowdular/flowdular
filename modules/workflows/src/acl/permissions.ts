export const WORKFLOWS_PERMISSIONS = {
	read: 'workflows.definitions.read',
	manage: 'workflows.definitions.manage',
	publish: 'workflows.definitions.publish',
	runsRead: 'workflows.runs.read',
	runsExecute: 'workflows.runs.execute',
	runsCancel: 'workflows.runs.cancel',
} as const;

export const permissions = Object.freeze(Object.values(WORKFLOWS_PERMISSIONS));
