export const EXAMPLE_PERMISSIONS = {
	read: 'example.notes.read',
	manage: 'example.notes.manage',
} as const;

export const permissions = Object.freeze(Object.values(EXAMPLE_PERMISSIONS));
