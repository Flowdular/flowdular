export const PROFILE_PERMISSIONS = {
	manageSelf: 'profile.self.manage',
} as const;

export const permissions = Object.freeze(Object.values(PROFILE_PERMISSIONS));
