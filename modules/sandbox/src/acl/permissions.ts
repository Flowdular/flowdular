export const SANDBOX_PERMISSIONS = {
	use: 'sandbox.access.use',
	manage: 'sandbox.access.manage',
	sessionsRead: 'sandbox.sessions.read',
	previewData: 'sandbox.preview.data',
	eject: 'sandbox.modules.eject',
} as const;

/* Capabilities a grant can carry. Managing grants stays a platform scope and
   is never delegated into the sandbox application. */
export const SANDBOX_GRANT_CAPABILITIES = Object.freeze([
	SANDBOX_PERMISSIONS.use,
	SANDBOX_PERMISSIONS.sessionsRead,
	SANDBOX_PERMISSIONS.previewData,
	SANDBOX_PERMISSIONS.eject,
]);

export const permissions = Object.freeze(Object.values(SANDBOX_PERMISSIONS));
