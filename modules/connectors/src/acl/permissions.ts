export const CONNECTORS_PERMISSIONS = {
	read: 'connectors.instances.read',
	manage: 'connectors.instances.manage',
} as const;

export const permissions = Object.freeze(Object.values(CONNECTORS_PERMISSIONS));
