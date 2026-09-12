import type {
	DatabaseHandle,
	DatabaseParameter,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { keysetWhere } from '@flowdular/server';
import type {
	ProvisioningEvent,
	ProvisioningEventQuery,
	ScimGroupMapping,
	ScimToken,
	ScimUserMapping,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	DirectoryRepository,
	GroupMemberChange,
	GroupMemberRow,
	GroupMemberStep,
	ResolvedGroupMember,
	ScimGroupFilter,
	ScimPageRequest,
	ScimSlice,
	ScimTokenSecret,
	ScimUserFilter,
} from './repository.ts';

interface TokenRow {
	id: string;
	tenant_id: string;
	label: string;
	token_fingerprint: string;
	token_hash: string;
	status: ScimToken['status'];
	created_by: string;
	created_at: number | bigint | string;
	last_used_at: number | bigint | string | null;
	expires_at: number | bigint | string | null;
	revoked_at: number | bigint | string | null;
}

interface UserRow {
	id: string;
	tenant_id: string;
	external_id: string | null;
	user_name: string;
	account_id: string;
	active: number | string;
	created_at: number | bigint | string;
	last_synced_at: number | bigint | string;
}

interface GroupRow {
	id: string;
	tenant_id: string;
	external_id: string | null;
	display_name: string;
	role_key: string | null;
	precedence: number | string;
	member_count: number | bigint | string;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface EventRow {
	id: string;
	sequence: number | bigint | string;
	tenant_id: string;
	token_id: string;
	operation: ProvisioningEvent['operation'];
	subject: string;
	outcome: ProvisioningEvent['outcome'];
	reason: string | null;
	occurred_at: number | bigint | string;
}

interface CountRow {
	total: number | bigint | string;
}

interface ResolvedRoleRow {
	user_id: string;
	account_id: string;
	role_key: string | null;
}

/** Rows one provisioning event insert carries, so one statement stays bounded. */
const EVENT_INSERT_BATCH = 200;

/** The unique indexes a caller can actually collide with. */
export const DIRECTORY_UNIQUE_INDEXES = {
	tokenLabel: 'directory_scim_tokens_label_idx',
	userName: 'directory_scim_users_user_name_idx',
	userAccount: 'directory_scim_users_account_idx',
	groupDisplayName: 'directory_scim_groups_display_name_idx',
} as const;

/** A unique violation, translated at the boundary so no driver text escapes. */
export class DirectoryUniqueViolation extends Error {
	constructor(readonly index: string) {
		super('A unique index rejected the write.');
		this.name = 'DirectoryUniqueViolation';
	}
}

/* 23505 is the SQLSTATE for a unique violation; the index name keeps a
   different unique index on the same table from being mistaken for it. */
function uniqueIndexOf(error: unknown): string | null {
	const cause = error as { code?: unknown; constraint?: unknown };
	const text = String(error);
	if (cause?.code !== '23505' && !text.includes('23505')) return null;
	const constraint = String(cause?.constraint ?? '');
	return (
		Object.values(DIRECTORY_UNIQUE_INDEXES).find(
			(index) => constraint.includes(index) || text.includes(index),
		) ?? null
	);
}

async function translatingUniqueViolation<T>(
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		const index = uniqueIndexOf(error);
		if (index) throw new DirectoryUniqueViolation(index);
		throw error;
	}
}

/* PostgreSQL returns BIGINT as a string, so every numeric read is normalized
   before it reaches the domain. */
function integer(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The directory database returned an invalid number.');
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
): number | null {
	return value === null ? null : integer(value);
}

const TOKEN_COLUMNS = `id, tenant_id, label, token_fingerprint, token_hash, status,
			 created_by, created_at, last_used_at, expires_at, revoked_at`;

const USER_COLUMNS = `id, tenant_id, external_id, user_name, account_id, active,
			 created_at, last_synced_at`;

/* The member count is derived on read: a stored counter would be a second
   source of truth for the same rows. */
const GROUP_COLUMNS = `g.id, g.tenant_id, g.external_id, g.display_name, g.role_key,
			 g.precedence, g.created_at, g.updated_at,
			 (SELECT count(*) FROM directory_scim_group_members m
			    WHERE m.tenant_id = g.tenant_id AND m.group_id = g.id) AS member_count`;

function tokenFromRow(row: TokenRow): ScimTokenSecret {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		label: row.label,
		tokenFingerprint: row.token_fingerprint,
		tokenHash: row.token_hash,
		status: row.status,
		createdBy: row.created_by,
		createdAt: integer(row.created_at),
		lastUsedAt: optionalInteger(row.last_used_at),
		expiresAt: optionalInteger(row.expires_at),
		revokedAt: optionalInteger(row.revoked_at),
	};
}

function withoutSecret(record: ScimTokenSecret): ScimToken {
	const { tokenHash: _hash, ...visible } = record;
	return visible;
}

function userFromRow(row: UserRow): ScimUserMapping {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		externalId: row.external_id,
		userName: row.user_name,
		accountId: row.account_id,
		active: Number(row.active) === 1,
		createdAt: integer(row.created_at),
		lastSyncedAt: integer(row.last_synced_at),
	};
}

function groupFromRow(row: GroupRow): ScimGroupMapping {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		externalId: row.external_id,
		displayName: row.display_name,
		roleKey: row.role_key,
		precedence: integer(row.precedence),
		memberCount: integer(row.member_count),
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
	};
}

function eventFromRow(row: EventRow): ProvisioningEvent {
	return {
		id: row.id,
		sequence: integer(row.sequence),
		tenantId: row.tenant_id,
		tokenId: row.token_id,
		operation: row.operation,
		subject: row.subject,
		outcome: row.outcome,
		reason: row.reason,
		occurredAt: integer(row.occurred_at),
	};
}

/**
 * Builds the WHERE clause of a filtered listing. Only the placeholder text is
 * assembled here; every value stays in the parameter channel.
 */
class Predicates {
	readonly parameters: DatabaseParameter[];
	readonly #clauses: string[] = [];

	constructor(tenantId: string, tenantColumn = 'tenant_id') {
		this.parameters = [tenantId];
		this.#clauses.push(tenantColumn + ' = $1');
	}

	add(expression: string, value: DatabaseParameter): void {
		this.parameters.push(value);
		const placeholder = '$' + this.parameters.length;
		this.#clauses.push(expression.replace('?', () => placeholder));
	}

	get where(): string {
		return this.#clauses.join(' AND ');
	}

	/** The next placeholder index, for LIMIT and OFFSET. */
	next(value: DatabaseParameter): string {
		this.parameters.push(value);
		return '$' + this.parameters.length;
	}
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseDirectoryRepository implements DirectoryRepository {
	constructor(private readonly database: DatabaseHandle) {}

	#read<T>(
		tenantId: string,
		run: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(run, { access: 'read', tenantId });
	}

	#write<T>(
		tenantId: string,
		run: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(run, { access: 'write', tenantId });
	}

	async listTokens(tenantId: string): Promise<readonly ScimToken[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<TokenRow>({
				text:
					'SELECT ' +
					TOKEN_COLUMNS +
					` FROM directory_scim_tokens
					 WHERE tenant_id = $1
					 ORDER BY lower(label), id`,
				parameters: [tenantId],
			}),
		);
		return result.rows.map((row) => withoutSecret(tokenFromRow(row)));
	}

	async findTokenById(tenantId: string, id: string): Promise<ScimToken | null> {
		const record = await this.#findToken(tenantId, 'id = $2', id);
		return record === null ? null : withoutSecret(record);
	}

	findTokenByFingerprint(
		tenantId: string,
		fingerprint: string,
	): Promise<ScimTokenSecret | null> {
		return this.#findToken(tenantId, 'token_fingerprint = $2', fingerprint);
	}

	async #findToken(
		tenantId: string,
		predicate: string,
		value: string,
	): Promise<ScimTokenSecret | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<TokenRow>({
				text:
					'SELECT ' +
					TOKEN_COLUMNS +
					' FROM directory_scim_tokens WHERE tenant_id = $1 AND ' +
					predicate,
				parameters: [tenantId, value],
			}),
		);
		const row = result.rows[0];
		return row ? tokenFromRow(row) : null;
	}

	async insertToken(record: ScimTokenSecret): Promise<void> {
		await translatingUniqueViolation(() =>
			this.#write(record.tenantId, (transaction) =>
				transaction.execute({
					text: `INSERT INTO directory_scim_tokens
					 (id, tenant_id, label, token_fingerprint, token_hash, status,
					  created_by, created_at, last_used_at, expires_at, revoked_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NULL)`,
					parameters: [
						record.id,
						record.tenantId,
						record.label,
						record.tokenFingerprint,
						record.tokenHash,
						record.status,
						record.createdBy,
						record.createdAt,
						record.expiresAt,
					],
				}),
			),
		);
	}

	async replaceTokenSecret(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly tokenFingerprint: string;
		readonly tokenHash: string;
		readonly expiresAt: number | null;
	}): Promise<boolean> {
		const result = await this.#write(input.tenantId, (transaction) =>
			transaction.execute({
				/* Only an active row: rotation replaces a working credential and
				   never puts one back on a token an owner revoked. */
				text: `UPDATE directory_scim_tokens
					 SET token_fingerprint = $3, token_hash = $4, expires_at = $5,
					     last_used_at = NULL
					 WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
				parameters: [
					input.tenantId,
					input.id,
					input.tokenFingerprint,
					input.tokenHash,
					input.expiresAt,
				],
			}),
		);
		return result.affectedRows > 0;
	}

	async revokeToken(
		tenantId: string,
		id: string,
		revokedAt: number,
	): Promise<boolean> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: `UPDATE directory_scim_tokens
					 SET status = 'revoked', revoked_at = $3
					 WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
				parameters: [tenantId, id, revokedAt],
			}),
		);
		return result.affectedRows > 0;
	}

	async touchToken(
		tenantId: string,
		id: string,
		usedAt: number,
	): Promise<void> {
		await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: `UPDATE directory_scim_tokens SET last_used_at = $3
					 WHERE tenant_id = $1 AND id = $2`,
				parameters: [tenantId, id, usedAt],
			}),
		);
	}

	async listUsers(
		tenantId: string,
		filter: ScimUserFilter,
		page: ScimPageRequest,
	): Promise<ScimSlice<ScimUserMapping>> {
		const predicates = new Predicates(tenantId);
		if (filter.userName !== undefined)
			predicates.add('user_name = ?', filter.userName);
		if (filter.externalId !== undefined)
			predicates.add('external_id = ?', filter.externalId);
		if (filter.id !== undefined) predicates.add('id = ?', filter.id);
		const where = predicates.where;
		const limit = predicates.next(page.count);
		const offset = predicates.next(page.startIndex - 1);
		return this.#read(tenantId, async (transaction) => {
			const total = await transaction.query<CountRow>({
				text:
					'SELECT count(*) AS total FROM directory_scim_users WHERE ' + where,
				parameters: predicates.parameters.slice(0, -2),
			});
			const rows = await transaction.query<UserRow>({
				text:
					'SELECT ' +
					USER_COLUMNS +
					' FROM directory_scim_users WHERE ' +
					where +
					' ORDER BY user_name, id LIMIT ' +
					limit +
					' OFFSET ' +
					offset,
				parameters: predicates.parameters,
			});
			return {
				records: rows.rows.map(userFromRow),
				totalResults: integer(total.rows[0]?.total ?? 0),
			};
		});
	}

	findUserById(tenantId: string, id: string): Promise<ScimUserMapping | null> {
		return this.#findUser(tenantId, 'id = $2', id);
	}

	findUserByUserName(
		tenantId: string,
		userName: string,
	): Promise<ScimUserMapping | null> {
		return this.#findUser(tenantId, 'user_name = $2', userName);
	}

	async findUsersByIds(
		tenantId: string,
		ids: readonly string[],
	): Promise<readonly ScimUserMapping[]> {
		const unique = [...new Set(ids)];
		if (unique.length === 0) return [];
		/* Only the placeholder text is generated; every id stays a bound value. */
		const placeholders = unique.map((_, index) => '$' + (index + 2)).join(', ');
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<UserRow>({
				text:
					'SELECT ' +
					USER_COLUMNS +
					' FROM directory_scim_users WHERE tenant_id = $1 AND id IN (' +
					placeholders +
					')',
				parameters: [tenantId, ...unique],
			}),
		);
		return result.rows.map(userFromRow);
	}

	async #findUser(
		tenantId: string,
		predicate: string,
		value: string,
	): Promise<ScimUserMapping | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<UserRow>({
				text:
					'SELECT ' +
					USER_COLUMNS +
					' FROM directory_scim_users WHERE tenant_id = $1 AND ' +
					predicate,
				parameters: [tenantId, value],
			}),
		);
		const row = result.rows[0];
		return row ? userFromRow(row) : null;
	}

	async insertUser(record: ScimUserMapping): Promise<void> {
		await translatingUniqueViolation(() =>
			this.#write(record.tenantId, (transaction) =>
				transaction.execute({
					text: `INSERT INTO directory_scim_users
					 (id, tenant_id, external_id, user_name, account_id, active,
					  created_at, last_synced_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
					parameters: [
						record.id,
						record.tenantId,
						record.externalId,
						record.userName,
						record.accountId,
						record.active ? 1 : 0,
						record.createdAt,
						record.lastSyncedAt,
					],
				}),
			),
		);
	}

	async updateUser(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly externalId: string | null;
		readonly active: boolean;
		readonly lastSyncedAt: number;
	}): Promise<void> {
		await this.#write(input.tenantId, (transaction) =>
			transaction.execute({
				text: `UPDATE directory_scim_users
					 SET external_id = $3, active = $4, last_synced_at = $5
					 WHERE tenant_id = $1 AND id = $2`,
				parameters: [
					input.tenantId,
					input.id,
					input.externalId,
					input.active ? 1 : 0,
					input.lastSyncedAt,
				],
			}),
		);
	}

	async listGroups(
		tenantId: string,
		filter: ScimGroupFilter,
		page: ScimPageRequest,
	): Promise<ScimSlice<ScimGroupMapping>> {
		const predicates = new Predicates(tenantId, 'g.tenant_id');
		if (filter.displayName !== undefined)
			predicates.add('lower(g.display_name) = lower(?)', filter.displayName);
		if (filter.externalId !== undefined)
			predicates.add('g.external_id = ?', filter.externalId);
		if (filter.id !== undefined) predicates.add('g.id = ?', filter.id);
		const where = predicates.where;
		const limit = predicates.next(page.count);
		const offset = predicates.next(page.startIndex - 1);
		return this.#read(tenantId, async (transaction) => {
			const total = await transaction.query<CountRow>({
				text:
					'SELECT count(*) AS total FROM directory_scim_groups AS g WHERE ' +
					where,
				parameters: predicates.parameters.slice(0, -2),
			});
			const rows = await transaction.query<GroupRow>({
				text:
					'SELECT ' +
					GROUP_COLUMNS +
					' FROM directory_scim_groups AS g WHERE ' +
					where +
					' ORDER BY g.precedence, lower(g.display_name), g.id LIMIT ' +
					limit +
					' OFFSET ' +
					offset,
				parameters: predicates.parameters,
			});
			return {
				records: rows.rows.map(groupFromRow),
				totalResults: integer(total.rows[0]?.total ?? 0),
			};
		});
	}

	findGroupById(
		tenantId: string,
		id: string,
	): Promise<ScimGroupMapping | null> {
		return this.#findGroup(tenantId, 'g.id = $2', id);
	}

	async #findGroup(
		tenantId: string,
		predicate: string,
		value: string,
	): Promise<ScimGroupMapping | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<GroupRow>({
				text:
					'SELECT ' +
					GROUP_COLUMNS +
					' FROM directory_scim_groups AS g WHERE g.tenant_id = $1 AND ' +
					predicate,
				parameters: [tenantId, value],
			}),
		);
		const row = result.rows[0];
		return row ? groupFromRow(row) : null;
	}

	async insertGroup(
		record: Omit<ScimGroupMapping, 'memberCount'>,
	): Promise<void> {
		await translatingUniqueViolation(() =>
			this.#write(record.tenantId, (transaction) =>
				transaction.execute({
					text: `INSERT INTO directory_scim_groups
					 (id, tenant_id, external_id, display_name, role_key, precedence,
					  created_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
					parameters: [
						record.id,
						record.tenantId,
						record.externalId,
						record.displayName,
						record.roleKey,
						record.precedence,
						record.createdAt,
						record.updatedAt,
					],
				}),
			),
		);
	}

	async updateGroup(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly externalId: string | null;
		readonly displayName: string;
		readonly roleKey: string | null;
		readonly precedence: number;
		readonly updatedAt: number;
	}): Promise<void> {
		await translatingUniqueViolation(() =>
			this.#write(input.tenantId, (transaction) =>
				transaction.execute({
					text: `UPDATE directory_scim_groups
					 SET external_id = $3, display_name = $4, role_key = $5,
					     precedence = $6, updated_at = $7
					 WHERE tenant_id = $1 AND id = $2`,
					parameters: [
						input.tenantId,
						input.id,
						input.externalId,
						input.displayName,
						input.roleKey,
						input.precedence,
						input.updatedAt,
					],
				}),
			),
		);
	}

	async deleteGroup(tenantId: string, id: string): Promise<boolean> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: 'DELETE FROM directory_scim_groups WHERE tenant_id = $1 AND id = $2',
				parameters: [tenantId, id],
			}),
		);
		return result.affectedRows > 0;
	}

	async listGroupMemberIds(
		tenantId: string,
		groupId: string,
	): Promise<readonly string[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{ user_id: string }>({
				text: `SELECT user_id FROM directory_scim_group_members
					 WHERE tenant_id = $1 AND group_id = $2
					 ORDER BY added_at, user_id`,
				parameters: [tenantId, groupId],
			}),
		);
		return result.rows.map((row) => row.user_id);
	}

	async listMembersOfGroups(
		tenantId: string,
		groupIds: readonly string[],
		perGroupLimit: number,
	): Promise<readonly GroupMemberRow[]> {
		const ids = [...new Set(groupIds)];
		if (ids.length === 0 || perGroupLimit < 1) return [];
		/* Only the placeholder text is generated; every id stays a bound value. */
		const placeholders = ids.map((_, index) => '$' + (index + 3)).join(', ');
		/* The window keeps one group's members from filling a whole page: a group
		   with more members than the bound is truncated, never streamed. */
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{
				group_id: string;
				user_id: string;
				user_name: string;
			}>({
				text:
					`SELECT group_id, user_id, user_name FROM (
					   SELECT m.group_id, m.user_id, u.user_name,
					          row_number() OVER (
					            PARTITION BY m.group_id ORDER BY u.user_name, m.user_id
					          ) AS position
					   FROM directory_scim_group_members AS m
					   JOIN directory_scim_users AS u
					     ON u.id = m.user_id AND u.tenant_id = m.tenant_id
					   WHERE m.tenant_id = $1 AND m.group_id IN (` +
					placeholders +
					`)
					 ) AS page
					 WHERE position <= $2
					 ORDER BY group_id, user_name`,
				parameters: [tenantId, perGroupLimit, ...ids],
			}),
		);
		return result.rows.map((row) => ({
			groupId: row.group_id,
			userId: row.user_id,
			userName: row.user_name,
		}));
	}

	applyGroupMembers(input: {
		readonly tenantId: string;
		readonly groupId: string;
		readonly steps: readonly GroupMemberStep[];
		readonly now: number;
	}): Promise<GroupMemberChange> {
		/* The membership is read and rewritten in one transaction, so a
		   concurrent change cannot make the diff act on a state that already
		   moved, and the steps keep the order the provider sent them in. */
		return this.#write(input.tenantId, async (transaction) => {
			const current = await transaction.query<{ user_id: string }>({
				text: `SELECT user_id FROM directory_scim_group_members
					 WHERE tenant_id = $1 AND group_id = $2`,
				parameters: [input.tenantId, input.groupId],
			});
			const before = new Set(current.rows.map((row) => row.user_id));
			const after = new Set(before);
			for (const step of input.steps) {
				if (step.kind === 'set') {
					after.clear();
					for (const member of step.members) after.add(member);
				} else if (step.kind === 'add') {
					for (const member of step.members) after.add(member);
				} else {
					for (const member of step.members) after.delete(member);
				}
			}
			const added = [...after].filter((member) => !before.has(member));
			const removed = [...before].filter((member) => !after.has(member));
			for (const userId of removed) {
				await transaction.execute({
					text: `DELETE FROM directory_scim_group_members
						 WHERE tenant_id = $1 AND group_id = $2 AND user_id = $3`,
					parameters: [input.tenantId, input.groupId, userId],
				});
			}
			for (const userId of added) {
				await transaction.execute({
					text: `INSERT INTO directory_scim_group_members
						 (tenant_id, group_id, user_id, added_at)
						 VALUES ($1, $2, $3, $4)`,
					parameters: [input.tenantId, input.groupId, userId, input.now],
				});
			}
			return { added, removed };
		});
	}

	resolvedRolesForGroup(
		tenantId: string,
		groupId: string,
	): Promise<readonly ResolvedGroupMember[]> {
		return this.#resolvedRoles(
			tenantId,
			`mapped_user.id IN (SELECT current_member.user_id
			    FROM directory_scim_group_members AS current_member
			   WHERE current_member.tenant_id = $1 AND current_member.group_id = $2)`,
			[groupId],
		);
	}

	resolvedRolesForUsers(
		tenantId: string,
		userIds: readonly string[],
	): Promise<readonly ResolvedGroupMember[]> {
		const unique = [...new Set(userIds)];
		if (unique.length === 0) return Promise.resolve([]);
		/* Only the placeholder text is generated; every id stays a bound value. */
		const placeholders = unique.map((_, index) => '$' + (index + 2)).join(', ');
		return this.#resolvedRoles(
			tenantId,
			'mapped_user.id IN (' + placeholders + ')',
			unique,
		);
	}

	/**
	 * The winning role of every named user in one pass: each user appears once,
	 * carrying the mapped role of lowest precedence among the groups they belong
	 * to, and a null role when no mapped group applies. The membership table is
	 * joined from the user rather than walked from it, so a user whose last
	 * group was just removed still answers, with nothing mapped.
	 */
	#resolvedRoles(
		tenantId: string,
		selection: string,
		parameters: readonly DatabaseParameter[],
	): Promise<readonly ResolvedGroupMember[]> {
		return this.#read(tenantId, async (transaction) => {
			const result = await transaction.query<ResolvedRoleRow>({
				text: `SELECT DISTINCT ON (mapped_user.id)
					   mapped_user.id AS user_id, mapped_user.account_id,
					   mapped_group.role_key
					 FROM directory_scim_users AS mapped_user
					 LEFT JOIN directory_scim_group_members AS member
					   ON member.user_id = mapped_user.id
					  AND member.tenant_id = mapped_user.tenant_id
					 LEFT JOIN directory_scim_groups AS mapped_group
					   ON mapped_group.id = member.group_id
					  AND mapped_group.tenant_id = member.tenant_id
					  AND mapped_group.role_key IS NOT NULL
					 WHERE mapped_user.tenant_id = $1 AND ${selection}
					 ORDER BY mapped_user.id, mapped_group.precedence NULLS LAST,
					          mapped_group.id`,
				parameters: [tenantId, ...parameters],
			});
			return result.rows.map((row) => ({
				userId: row.user_id,
				accountId: row.account_id,
				roleKey: row.role_key,
			}));
		});
	}

	appendEvent(event: Omit<ProvisioningEvent, 'sequence'>): Promise<void> {
		return this.appendEvents([event]);
	}

	/* One statement per batch: a membership change touching a whole group would
	   otherwise pay a transaction per member it recorded. */
	async appendEvents(
		events: readonly Omit<ProvisioningEvent, 'sequence'>[],
	): Promise<void> {
		const first = events[0];
		if (!first) return;
		/* The statement binds one tenant id for every row it writes, so a batch
		   spanning two workspaces would file one of them under the other. */
		if (events.some((event) => event.tenantId !== first.tenantId)) {
			throw new Error('A provisioning event batch covers one workspace.');
		}
		for (let start = 0; start < events.length; start += EVENT_INSERT_BATCH) {
			const batch = events.slice(start, start + EVENT_INSERT_BATCH);
			const parameters: DatabaseParameter[] = [first.tenantId];
			const rows = batch.map((event) => {
				const placeholders = [
					event.id,
					event.tokenId,
					event.operation,
					event.subject,
					event.outcome,
					event.reason,
					event.occurredAt,
				].map((value) => {
					parameters.push(value);
					return '$' + parameters.length;
				});
				return `(${placeholders[0]}, $1, ${placeholders.slice(1).join(', ')})`;
			});
			await this.#write(first.tenantId, (transaction) =>
				transaction.execute({
					text: `INSERT INTO directory_provisioning_events
					 (id, tenant_id, token_id, operation, subject, outcome, reason, occurred_at)
					 VALUES ${rows.join(', ')}`,
					parameters,
				}),
			);
		}
	}

	async listEvents(
		tenantId: string,
		query: ProvisioningEventQuery,
	): Promise<readonly ProvisioningEvent[]> {
		const predicates = new Predicates(tenantId);
		if (query.operation !== undefined)
			predicates.add('operation = ?', query.operation);
		if (query.outcome !== undefined)
			predicates.add('outcome = ?', query.outcome);
		let where = predicates.where;
		if (query.cursor) {
			/* Keyset paging over the same order the index carries, so a page never
			   re-reads the rows before it. */
			const keyset = keysetWhere(
				['occurred_at', 'sequence'],
				[query.cursor.occurredAt, query.cursor.sequence],
				{ direction: 'desc', parameterOffset: predicates.parameters.length },
			);
			where += ' AND ' + keyset.text;
			predicates.parameters.push(...keyset.parameters);
		}
		const limit = predicates.next(query.limit);
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EventRow>({
				text:
					`SELECT id, sequence, tenant_id, token_id, operation, subject,
					        outcome, reason, occurred_at
					 FROM directory_provisioning_events WHERE ` +
					where +
					' ORDER BY occurred_at DESC, sequence DESC LIMIT ' +
					limit,
				parameters: predicates.parameters,
			}),
		);
		return result.rows.map(eventFromRow);
	}

	/* The index is (tenant_id, occurred_at DESC, sequence DESC), so the subquery
	   picks the batch through it and the delete removes exactly those rows. */
	async sweepEvents(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<{ readonly removed: number }> {
		const removed = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: `DELETE FROM directory_provisioning_events WHERE id IN (
					   SELECT id FROM directory_provisioning_events
					   WHERE tenant_id = $1 AND occurred_at < $2
					   ORDER BY occurred_at, sequence LIMIT $3)`,
				parameters: [tenantId, before, limit],
			}),
		);
		return { removed: removed.affectedRows };
	}

	async exportEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly ProvisioningEvent[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EventRow>({
				text: `SELECT id, sequence, tenant_id, token_id, operation, subject,
				        outcome, reason, occurred_at
				 FROM directory_provisioning_events
				 WHERE tenant_id = $1 AND sequence > $2
				 ORDER BY sequence LIMIT $3`,
				parameters: [tenantId, afterSequence, limit],
			}),
		);
		return result.rows.map(eventFromRow);
	}
}

export async function migrateDirectoryDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'directory.core', databaseMigrations);
}
