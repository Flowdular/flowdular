export const ADAPTERS_PERMISSIONS = {
	read: 'adapters.runs.read',
	manage: 'adapters.runs.manage',
} as const;

export const permissions = Object.freeze(Object.values(ADAPTERS_PERMISSIONS));
