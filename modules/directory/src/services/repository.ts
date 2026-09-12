import type {
	ProvisioningEvent,
	ProvisioningEventQuery,
	ScimGroupMapping,
	ScimToken,
	ScimUserMapping,
} from '../domain/types.ts';

/** A stored token with the secret material authentication compares against. */
export interface ScimTokenSecret extends ScimToken {
	readonly tokenHash: string;
}

export interface ScimUserFilter {
	readonly userName?: string | undefined;
	readonly externalId?: string | undefined;
	readonly id?: string | undefined;
}

export interface ScimGroupFilter {
	readonly displayName?: string | undefined;
	readonly externalId?: string | undefined;
	readonly id?: string | undefined;
}

export interface ScimSlice<Record> {
	readonly records: readonly Record[];
	readonly totalResults: number;
}

export interface ScimPageRequest {
	/** 1-based, as the SCIM protocol counts. */
	readonly startIndex: number;
	readonly count: number;
}

/** One member of a group with the role its mapped groups currently resolve to. */
export interface ResolvedGroupMember {
	readonly userId: string;
	readonly accountId: string;
	readonly roleKey: string | null;
}

export interface GroupMemberRow {
	readonly groupId: string;
	readonly userId: string;
	readonly userName: string;
}

export interface GroupMemberChange {
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

/**
 * One membership operation as the provider sent it. `set` replaces the whole
 * membership; the steps of a request are applied in the order received, which
 * is what makes two operations on the same member resolve the way SCIM says.
 */
export interface GroupMemberStep {
	readonly kind: 'set' | 'add' | 'remove';
	readonly members: readonly string[];
}

/**
 * Async and database-agnostic. Every method takes the trusted tenant id, which
 * the transaction binds as the row-security context as well.
 */
export interface DirectoryRepository {
	listTokens(tenantId: string): Promise<readonly ScimToken[]>;
	findTokenById(tenantId: string, id: string): Promise<ScimToken | null>;
	findTokenByFingerprint(
		tenantId: string,
		fingerprint: string,
	): Promise<ScimTokenSecret | null>;
	insertToken(record: ScimTokenSecret): Promise<void>;
	replaceTokenSecret(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly tokenFingerprint: string;
		readonly tokenHash: string;
		readonly expiresAt: number | null;
	}): Promise<boolean>;
	revokeToken(
		tenantId: string,
		id: string,
		revokedAt: number,
	): Promise<boolean>;
	touchToken(tenantId: string, id: string, usedAt: number): Promise<void>;

	listUsers(
		tenantId: string,
		filter: ScimUserFilter,
		page: ScimPageRequest,
	): Promise<ScimSlice<ScimUserMapping>>;
	findUserById(tenantId: string, id: string): Promise<ScimUserMapping | null>;
	/** One query for a bounded set of ids, so a member list costs one round trip. */
	findUsersByIds(
		tenantId: string,
		ids: readonly string[],
	): Promise<readonly ScimUserMapping[]>;
	findUserByUserName(
		tenantId: string,
		userName: string,
	): Promise<ScimUserMapping | null>;
	insertUser(record: ScimUserMapping): Promise<void>;
	updateUser(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly externalId: string | null;
		readonly active: boolean;
		readonly lastSyncedAt: number;
	}): Promise<void>;

	listGroups(
		tenantId: string,
		filter: ScimGroupFilter,
		page: ScimPageRequest,
	): Promise<ScimSlice<ScimGroupMapping>>;
	findGroupById(tenantId: string, id: string): Promise<ScimGroupMapping | null>;
	insertGroup(record: Omit<ScimGroupMapping, 'memberCount'>): Promise<void>;
	updateGroup(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly externalId: string | null;
		readonly displayName: string;
		readonly roleKey: string | null;
		readonly precedence: number;
		readonly updatedAt: number;
	}): Promise<void>;
	deleteGroup(tenantId: string, id: string): Promise<boolean>;

	listGroupMemberIds(
		tenantId: string,
		groupId: string,
	): Promise<readonly string[]>;
	/**
	 * One query for a whole page of groups, bounded per group: a listing must
	 * not be able to load a workspace's entire membership into one response.
	 */
	listMembersOfGroups(
		tenantId: string,
		groupIds: readonly string[],
		perGroupLimit: number,
	): Promise<readonly GroupMemberRow[]>;
	/**
	 * Applies the steps in order inside one transaction and returns what
	 * actually changed, so a repeat of the same state writes nothing.
	 */
	applyGroupMembers(input: {
		readonly tenantId: string;
		readonly groupId: string;
		readonly steps: readonly GroupMemberStep[];
		readonly now: number;
	}): Promise<GroupMemberChange>;

	/**
	 * The winning role of every member of the group, and of every named user,
	 * from one precedence rule: the mapped group with the lowest precedence, or
	 * null when none applies. A named user who belongs to no group answers with
	 * a null role rather than not at all.
	 */
	resolvedRolesForGroup(
		tenantId: string,
		groupId: string,
	): Promise<readonly ResolvedGroupMember[]>;
	resolvedRolesForUsers(
		tenantId: string,
		userIds: readonly string[],
	): Promise<readonly ResolvedGroupMember[]>;

	/** The sequence is assigned by storage, so a caller never supplies one. */
	appendEvent(event: Omit<ProvisioningEvent, 'sequence'>): Promise<void>;
	/** One workspace's events in as few statements as the batch size allows. */
	appendEvents(
		events: readonly Omit<ProvisioningEvent, 'sequence'>[],
	): Promise<void>;
	listEvents(
		tenantId: string,
		query: ProvisioningEventQuery,
	): Promise<readonly ProvisioningEvent[]>;

	/** Removes at most `limit` events that occurred strictly before `before`. */
	sweepEvents(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<{ readonly removed: number }>;
	/** One export page, ordered by the storage sequence the log is written in. */
	exportEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly ProvisioningEvent[]>;
}
