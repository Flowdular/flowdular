export const USER_PERMISSIONS = {
	read: 'users.members.read',
	manage: 'users.members.manage',
} as const;

export const permissions = Object.freeze(Object.values(USER_PERMISSIONS));
