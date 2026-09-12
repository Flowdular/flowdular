export const ACCESS_PERMISSIONS = {
	read: 'access.review.read',
	manage: 'access.review.manage',
} as const;

export const permissions = Object.freeze(Object.values(ACCESS_PERMISSIONS));
