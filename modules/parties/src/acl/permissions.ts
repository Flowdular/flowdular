export const PARTY_PERMISSIONS = {
	read: 'parties.records.read',
	manage: 'parties.records.manage',
} as const;

export const permissions = Object.freeze(Object.values(PARTY_PERMISSIONS));
