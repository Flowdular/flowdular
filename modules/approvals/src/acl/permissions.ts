export const APPROVALS_PERMISSIONS = {
	read: 'approvals.requests.read',
	decide: 'approvals.requests.decide',
	manage: 'approvals.requests.manage',
} as const;

export const permissions = Object.freeze(Object.values(APPROVALS_PERMISSIONS));
