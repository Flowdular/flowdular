export const DOCUMENTS_PERMISSIONS = {
	read: 'documents.files.read',
	manage: 'documents.files.manage',
} as const;

export const permissions = Object.freeze(Object.values(DOCUMENTS_PERMISSIONS));
