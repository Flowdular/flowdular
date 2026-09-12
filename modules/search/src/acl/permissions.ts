export const SEARCH_PERMISSIONS = {
	read: 'search.records.read',
} as const;

export const permissions = Object.freeze(Object.values(SEARCH_PERMISSIONS));
