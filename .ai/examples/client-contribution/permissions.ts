/* In a module this is src/acl/permissions.ts. The strings equal
   spec/module.yaml permissions[].id. */
export const CUSTOMER_PERMISSIONS = {
	read: 'customers.records.read',
	manage: 'customers.records.manage',
} as const;

export const permissions = Object.freeze(Object.values(CUSTOMER_PERMISSIONS));
