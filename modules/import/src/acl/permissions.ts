export const IMPORT_PERMISSIONS = {
	read: 'import.jobs.read',
	manage: 'import.jobs.manage',
} as const;

export const permissions = Object.freeze(Object.values(IMPORT_PERMISSIONS));
