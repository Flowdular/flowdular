export const EXPORTS_PERMISSIONS = {
	read: 'exports.lists.read',
	manage: 'exports.lists.manage',
} as const;

export const permissions = Object.freeze(Object.values(EXPORTS_PERMISSIONS));
