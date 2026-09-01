export const EXPENSES_PERMISSIONS = {
	read: 'expenses.claims.read',
	manage: 'expenses.claims.manage',
	approve: 'expenses.claims.approve',
} as const;

export const permissions = Object.freeze(Object.values(EXPENSES_PERMISSIONS));
