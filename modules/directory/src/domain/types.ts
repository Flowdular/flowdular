export const SCIM_TOKEN_STATUSES = ['active', 'revoked'] as const;

export type ScimTokenStatus = (typeof SCIM_TOKEN_STATUSES)[number];

/** A SCIM credential as anyone may read it: the secret is never part of it. */
export interface ScimToken {
	readonly id: string;
	readonly tenantId: string;
	readonly label: string;
	/** Truncated SHA-256 of the token, also the authentication lookup key. */
	readonly tokenFingerprint: string;
	readonly status: ScimTokenStatus;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly lastUsedAt: number | null;
	readonly expiresAt: number | null;
	readonly revokedAt: number | null;
}

/** The one moment the token value exists outside the provider's configuration. */
export interface IssuedScimToken {
	readonly record: ScimToken;
	readonly token: string;
}

export interface ScimUserMapping {
	readonly id: string;
	readonly tenantId: string;
	readonly externalId: string | null;
	readonly userName: string;
	readonly accountId: string;
	readonly active: boolean;
	readonly createdAt: number;
	readonly lastSyncedAt: number;
}

export interface ScimGroupMapping {
	readonly id: string;
	readonly tenantId: string;
	readonly externalId: string | null;
	readonly displayName: string;
	/** Empty means the group is tracked but grants nothing. */
	readonly roleKey: string | null;
	readonly precedence: number;
	/** Derived from the membership rows; no counter is stored. */
	readonly memberCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export const PROVISIONING_OPERATIONS = [
	'user-create',
	'user-update',
	'user-deactivate',
	'user-reactivate',
	'group-create',
	'group-update',
	'group-delete',
	'membership-change',
] as const;

export type ProvisioningOperation = (typeof PROVISIONING_OPERATIONS)[number];

export const PROVISIONING_OUTCOMES = [
	'applied',
	'unchanged',
	'refused',
] as const;

export type ProvisioningOutcome = (typeof PROVISIONING_OUTCOMES)[number];

export interface ProvisioningEvent {
	readonly id: string;
	/** Storage order within one millisecond; the log is read by it. */
	readonly sequence: number;
	readonly tenantId: string;
	readonly tokenId: string;
	readonly operation: ProvisioningOperation;
	readonly subject: string;
	readonly outcome: ProvisioningOutcome;
	readonly reason: string | null;
	readonly occurredAt: number;
}

/** The keyset of the last row of a page: `(occurredAt, sequence)` descending. */
export interface ProvisioningEventCursor {
	readonly occurredAt: number;
	readonly sequence: number;
}

export interface ProvisioningEventQuery {
	readonly operation?: ProvisioningOperation | undefined;
	readonly outcome?: ProvisioningOutcome | undefined;
	readonly limit: number;
	readonly cursor?: ProvisioningEventCursor | undefined;
}

/** Stable reason codes. They travel in the log and in every SCIM refusal. */
export const DIRECTORY_REASONS = {
	accountInUse: 'ACCOUNT_IN_USE',
	defaultRoleUnknown: 'DEFAULT_ROLE_UNKNOWN',
	groupExists: 'GROUP_EXISTS',
	groupNotFound: 'GROUP_NOT_FOUND',
	immutableEmail: 'IMMUTABLE_EMAIL',
	immutableUserName: 'IMMUTABLE_USER_NAME',
	invalidValue: 'INVALID_VALUE',
	lastOwner: 'LAST_OWNER',
	memberNotFound: 'MEMBER_NOT_FOUND',
	noEnabledProvider: 'NO_ENABLED_PROVIDER',
	rateLimited: 'RATE_LIMITED',
	rollbackFailed: 'ROLLBACK_FAILED',
	roleUnknown: 'ROLE_UNKNOWN',
	unauthorized: 'UNAUTHORIZED',
	unsupportedFilter: 'UNSUPPORTED_FILTER',
	unsupportedOperation: 'UNSUPPORTED_OPERATION',
	unsupportedPath: 'UNSUPPORTED_PATH',
	userExists: 'USER_EXISTS',
	userNotFound: 'USER_NOT_FOUND',
} as const;
