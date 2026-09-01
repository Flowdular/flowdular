export const CATALOG_PERMISSIONS = {
	read: 'catalog.items.read',
	manage: 'catalog.items.manage',
} as const;

export const permissions = Object.freeze(Object.values(CATALOG_PERMISSIONS));
