export const AUDIT_PERMISSIONS = {
	read: 'audit.registry.read',
	retentionManage: 'audit.retention.manage',
	holdsManage: 'audit.holds.manage',
} as const;

export const permissions = Object.freeze(Object.values(AUDIT_PERMISSIONS));
