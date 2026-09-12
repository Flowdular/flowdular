export const DIRECTORY_PERMISSIONS = {
	read: 'directory.tokens.read',
	manage: 'directory.tokens.manage',
	provisioningRead: 'directory.provisioning.read',
} as const;

export const permissions = Object.freeze(Object.values(DIRECTORY_PERMISSIONS));
