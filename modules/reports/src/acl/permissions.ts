export const REPORTS_PERMISSIONS = {
	read: 'reports.workspace.read',
} as const;

export const permissions = Object.freeze(Object.values(REPORTS_PERMISSIONS));
