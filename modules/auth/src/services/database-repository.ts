import {
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseParameter,
	type DatabaseStatement,
	type DatabaseTransaction,
} from '@flowdular/database';
import type {
	ActorKind,
	ModuleSettingRecord,
	ModuleSettingValue,
} from '@flowdular/kernel';
import { BUILTIN_ROLES } from '../acl/scopes.ts';
import type {
	ApiTokenRecord,
	AuditEvent,
	AuditQuery,
	AuthPrincipal,
	AuthSession,
	AuthTenantAccess,
	IdentityProviderStatus,
	MembershipStatus,
	SessionSummary,
	TenantRole,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import {
	DuplicateAccountError,
	DuplicateProviderKeyError,
	DuplicateRoleKeyError,
	DuplicateTenantSlugError,
	type AccountCredential,
	type AccountIdentity,
	type AuditActorEvent,
	type AuditRecord,
	type AuthRepository,
	type CreateAccountInTenantRecord,
	type CreateAccountRecord,
	type CreateApiTokenRecord,
	type CreateRoleRecord,
	type CreateSessionRecord,
	type CreateTenantMembershipRecord,
	type ExternalIdentityBinding,
	type ExternalIdentityRecord,
	type IdentityProviderPatch,
	type IdentityProviderRecord,
	type MfaChallengeRecord,
	type PasswordResetTokenRecord,
	type SessionExportRecord,
	type SignInFailureRecord,
	type TenantInvitationRecord,
	type TenantMember,
	type TenantSummary,
} from './repository.ts';
import type { SealedMfaSecret } from './totp.ts';

/**
 * The tenant context an identity table is read and written under. Accounts,
 * sign-in failures, reset tokens and enrolled factors belong to a person, not
 * to a workspace, so they carry no tenant column and no policy binds this
 * value. The runtime handle still requires one, and no workspace can claim it:
 * a tenant id is a UUID.
 */
export const IDENTITY_TENANT_CONTEXT = 'auth.core:identity';

/**
 * Rows one expired-session delete removes. The sweep walks a backlog of
 * unknown size, and a single delete over it would hold the table for as long as
 * it takes; a bounded batch keeps every statement short and leaves the rest to
 * the next batch.
 */
export const EXPIRED_SESSION_SWEEP_BATCH = 1_000;

/**
 * Storage tenant of a platform-scoped setting. The kernel addresses it as the
 * empty string, which is not a tenant id a policy can be bound to, so the row
 * carries this reserved id instead.
 */
export const PLATFORM_SETTINGS_STORAGE_TENANT = 'auth.core:platform';

interface ApiTokenRow {
	id: string;
	tenant_id: string;
	account_id: string;
	label: string;
	prefix: string;
	token_hash: string;
	scopes_json: string;
	created_by: string;
	created_at: number | bigint | string;
	expires_at: number | bigint | string | null;
	last_used_at: number | bigint | string | null;
	revoked_at: number | bigint | string | null;
	revoked_by: string | null;
}

interface AccountRow {
	account_id: string;
	tenant_id: string;
	email: string;
	display_name: string;
	password_hash: string;
	role: string;
	role_id: string | null;
	status: 'active' | 'disabled';
	membership_status: MembershipStatus;
	password_change_required: number | bigint | string;
}

interface ScopeRow {
	scope: string;
}

interface TenantAccessRow {
	tenant_id: string;
	name: string;
	slug: string;
	role: string;
}

interface TenantMemberRow {
	account_id: string;
	email: string;
	display_name: string;
	role: string;
	role_id: string | null;
	status: 'active' | 'disabled';
	membership_status: MembershipStatus;
	password_change_required: number | bigint | string;
	scopes: string | null;
	created_at: number | bigint | string;
}

interface IdentityProviderRow {
	id: string;
	tenant_id: string;
	key: string;
	label: string;
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	user_info_endpoint: string;
	client_id: string;
	client_secret_ciphertext: string;
	client_secret_key_id: string;
	client_secret_fingerprint: string;
	scopes_json: string;
	jit_enabled: number | bigint | string;
	allowed_domains_json: string;
	jit_role: string;
	status: IdentityProviderStatus;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface SessionRow extends AccountRow {
	session_id: string;
	csrf_token: string;
	expires_at: number | bigint | string;
	last_seen_at: number | bigint | string;
}

interface SessionSummaryRow {
	id: string;
	tenant_id: string;
	tenant_name: string;
	created_at: number | bigint | string;
	last_seen_at: number | bigint | string;
	expires_at: number | bigint | string;
}

interface RoleRow {
	id: string;
	tenant_id: string;
	key: string;
	name: string;
	description: string;
	scopes_json: string;
	builtin: number | bigint | string;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface SessionExportRow {
	id: string;
	tenant_id: string;
	account_id: string;
	created_at: number | bigint | string;
	expires_at: number | bigint | string;
	last_seen_at: number | bigint | string;
}

interface AuditRow {
	id: number | bigint | string;
	tenant_id: string;
	actor_account_id: string | null;
	actor_label: string;
	actor_kind: ActorKind;
	actor_run_id: string | null;
	action: string;
	subject_type: string;
	subject_id: string;
	metadata_json: string;
	occurred_at: number | bigint | string;
}

interface TenantRow {
	id: string;
	name: string;
	slug: string | null;
}

interface CountRow {
	total: number | bigint | string;
}

/* PostgreSQL returns BIGINT as a string, and every timestamp, expiry and
   counter here is one. An unnormalized read would compare and serialize as
   text: a session would never look expired and a role would never look
   built in. */
function integer(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The auth database returned an invalid integer.');
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
): number | null {
	return value === null ? null : integer(value);
}

const ACCOUNT_COLUMNS = `a.id AS account_id, m.tenant_id, a.email, a.display_name,
	 a.password_hash, m.role, m.role_id, a.status,
	 m.status AS membership_status, a.password_change_required`;

/* One projection for the whole roll and for a single member, so the two reads
   can never disagree about what a member is. */
const TENANT_MEMBER_COLUMNS = `a.id AS account_id, a.email, a.display_name,
	 m.role, m.role_id, a.status, m.status AS membership_status,
	 a.password_change_required, m.created_at,
	 (SELECT string_agg(s.scope, ' ' ORDER BY s.scope)
	    FROM auth_membership_scopes s
	    WHERE s.account_id = m.account_id AND s.tenant_id = m.tenant_id) AS scopes`;

/**
 * The member search statement, exported so a plan assertion explains the
 * statement the repository runs rather than a copy of it that can drift away
 * from the indexes it was written for.
 */
export const TENANT_MEMBER_SEARCH_SQL = `SELECT ${TENANT_MEMBER_COLUMNS}
       FROM auth_memberships m
       JOIN auth_accounts a ON a.id = m.account_id
       WHERE m.tenant_id = $1
         AND (lower(a.display_name) LIKE $2 ESCAPE '\\'
              OR a.email_normalized LIKE $2 ESCAPE '\\')
       ORDER BY lower(a.display_name), a.id
       LIMIT $3`;

/**
 * One PostgreSQL `text[]` literal. A bound parameter carries no array type, so
 * a list travels as this literal and the statement casts it back. Every element
 * is quoted with its backslashes and quotes escaped, so no element can close
 * the literal early or add one of its own.
 */
export function textArrayLiteral(values: readonly string[]): string {
	return `{${values
		.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
		.join(',')}}`;
}

interface ExternalIdentityBindingRow {
	account_id: string;
	provider: string;
	subject: string;
	created_at: number | bigint | string;
}

function tenantMemberFrom(row: TenantMemberRow): TenantMember {
	return {
		accountId: row.account_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role,
		roleId: row.role_id,
		status: row.status,
		membershipStatus: row.membership_status,
		scopes: row.scopes ? row.scopes.split(' ') : [],
		passwordChangeRequired: integer(row.password_change_required) === 1,
		createdAt: integer(row.created_at),
	};
}

export function builtinRoleId(tenantId: string, key: string): string {
	return `${tenantId}:${key}`;
}

function fromApiTokenRow(row: ApiTokenRow): ApiTokenRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		accountId: row.account_id,
		label: row.label,
		prefix: row.prefix,
		scopes: JSON.parse(row.scopes_json) as readonly string[],
		createdBy: row.created_by,
		createdAt: integer(row.created_at),
		expiresAt: optionalInteger(row.expires_at),
		lastUsedAt: optionalInteger(row.last_used_at),
		revokedAt: optionalInteger(row.revoked_at),
		revokedBy: row.revoked_by,
	};
}

function fromRoleRow(row: RoleRow): TenantRole {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.key,
		name: row.name,
		description: row.description,
		scopes: JSON.parse(row.scopes_json) as readonly string[],
		builtin: integer(row.builtin) === 1,
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
	};
}

function fromIdentityProviderRow(
	row: IdentityProviderRow,
): IdentityProviderRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.key,
		label: row.label,
		issuer: row.issuer,
		authorizationEndpoint: row.authorization_endpoint,
		tokenEndpoint: row.token_endpoint,
		userInfoEndpoint: row.user_info_endpoint,
		clientId: row.client_id,
		secretCiphertext: row.client_secret_ciphertext,
		secretKeyId: row.client_secret_key_id,
		secretFingerprint: row.client_secret_fingerprint,
		scopes: JSON.parse(row.scopes_json) as readonly string[],
		jitEnabled: integer(row.jit_enabled) === 1,
		allowedDomains: JSON.parse(row.allowed_domains_json) as readonly string[],
		jitRole: row.jit_role,
		status: row.status,
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
	};
}

function tenantSummary(row: TenantRow): TenantSummary {
	return { tenantId: row.id, name: row.name, slug: row.slug ?? row.id };
}

/* A unique violation arrives as the driver's own error. The constraint name is
   the only stable part of it, so the duplicate a caller can act on is
   recognized by name and everything else is rethrown untouched. */
function duplicate(
	error: unknown,
): 'email' | 'role-key' | 'slug' | 'provider-key' | null {
	const text = String(error);
	if (text.includes('auth_accounts_email_normalized_key')) return 'email';
	if (text.includes('auth_tenants_slug_idx')) return 'slug';
	if (text.includes('auth_roles_tenant_id_key_key')) return 'role-key';
	if (text.includes('auth_identity_providers_tenant_id_key_key')) {
		return 'provider-key';
	}
	return null;
}

/** Values always travel as parameters; only the marker count is assembled. */
function scopeRows(
	accountId: string,
	tenantId: string,
	scopes: readonly string[],
): DatabaseStatement | null {
	const unique = [...new Set(scopes)];
	if (unique.length === 0) return null;
	const parameters: DatabaseParameter[] = [accountId, tenantId];
	const rows = unique.map((scope) => {
		parameters.push(scope);
		return `($1, $2, $${parameters.length})`;
	});
	return {
		text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
		       VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING`,
		parameters,
	};
}

export async function migrateAuthDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'auth.core', databaseMigrations);
}

export interface AuthDatabaseHandles {
	/** Tenant-scoped handle: every request-time read and write runs on it. */
	readonly runtime: DatabaseHandle;
	/**
	 * Read-only cross-tenant handle. A session cookie, a bearer token, an
	 * invitation link and an email address name no workspace, so this handle
	 * answers one question only: which tenant owns the row. Everything the
	 * answer is used for is read and written again under that tenant.
	 */
	readonly background: DatabaseHandle;
}

interface RoutedTenantRow {
	tenant_id: string;
}

/** auth.core over platform-owned PostgreSQL handles. */
export class DatabaseAuthRepository implements AuthRepository {
	readonly #runtime: DatabaseHandle;
	readonly #background: DatabaseHandle;

	constructor(handles: AuthDatabaseHandles) {
		this.#runtime = handles.runtime;
		this.#background = handles.background;
	}

	#tx<T>(
		tenantId: string,
		access: 'read' | 'write',
		body: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.#runtime.transaction(body, { access, tenantId });
	}

	async #query<Row extends object>(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const result = await transaction.query<Row>(statement);
			return result.rows;
		});
	}

	async #exec(tenantId: string, statement: DatabaseStatement): Promise<number> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.execute(statement);
			return result.affectedRows;
		});
	}

	/** A cross-tenant routing read. It returns which tenant owns a key, never a record. */
	async #route<Row extends object>(
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		const result = await this.#background.query<Row>(statement);
		return result.rows;
	}

	/* A disabled membership answers for nothing: it must not be the workspace a
	   session cookie, a bearer token or a sign-in resolves to. */
	async #tenantOfAccount(accountId: string): Promise<string | null> {
		const rows = await this.#route<RoutedTenantRow>({
			text: `SELECT tenant_id FROM auth_memberships
			       WHERE account_id = $1 AND status = 'active'
			       ORDER BY created_at, tenant_id LIMIT 1`,
			parameters: [accountId],
		});
		return rows[0]?.tenant_id ?? null;
	}

	async #scopes(
		transaction: DatabaseTransaction,
		accountId: string,
		tenantId: string,
	): Promise<string[]> {
		const result = await transaction.query<ScopeRow>({
			text: `SELECT scope FROM auth_membership_scopes
			       WHERE account_id = $1 AND tenant_id = $2 ORDER BY scope`,
			parameters: [accountId, tenantId],
		});
		return result.rows.map((row) => row.scope);
	}

	async #credential(
		transaction: DatabaseTransaction,
		row: AccountRow,
	): Promise<AccountCredential> {
		return {
			accountId: row.account_id,
			tenantId: row.tenant_id,
			email: row.email,
			displayName: row.display_name,
			passwordHash: row.password_hash,
			role: row.role,
			roleId: row.role_id,
			status: row.status,
			membershipStatus: row.membership_status,
			passwordChangeRequired: integer(row.password_change_required) === 1,
			scopes: await this.#scopes(transaction, row.account_id, row.tenant_id),
		};
	}

	/* Every workspace carries the built-in roles as rows, so a custom role and a
	   built-in one are listed, assigned and audited the same way. They are
	   written with the workspace itself, inside its own transaction. */
	async #seedBuiltinRoles(
		transaction: DatabaseTransaction,
		tenantId: string,
		createdAt: number,
	): Promise<void> {
		for (const role of BUILTIN_ROLES) {
			await transaction.execute({
				text: `INSERT INTO auth_roles
				       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
				       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)
				       ON CONFLICT DO NOTHING`,
				parameters: [
					builtinRoleId(tenantId, role.key),
					tenantId,
					role.key,
					role.name,
					role.description,
					JSON.stringify(role.scopes),
					createdAt,
				],
			});
		}
	}

	async #insertScopes(
		transaction: DatabaseTransaction,
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<void> {
		const statement = scopeRows(accountId, tenantId, scopes);
		if (statement) await transaction.execute(statement);
	}

	/* The service may have read the role before hashing a password or preparing
	   an invitation. Reread owners inside the write transaction and hold the
	   role lock until insertion commits, so a concurrent module grant either
	   precedes this snapshot or includes the newly committed membership. */
	async #assignedScopes(
		transaction: DatabaseTransaction,
		tenantId: string,
		role: string,
		scopes: readonly string[],
	): Promise<readonly string[]> {
		if (role !== 'owner') return scopes;
		const roles = await transaction.query<RoleRow>({
			text: `SELECT * FROM auth_roles
			       WHERE tenant_id = $1 AND key = 'owner' AND builtin = 1 FOR SHARE`,
			parameters: [tenantId],
		});
		if (!roles.rows[0])
			throw new Error('The workspace has no built-in owner role.');
		return fromRoleRow(roles.rows[0]).scopes;
	}

	async #membership(
		transaction: DatabaseTransaction,
		accountId: string,
		tenantId: string,
	): Promise<AccountCredential | null> {
		const result = await transaction.query<AccountRow>({
			text: `SELECT ${ACCOUNT_COLUMNS}
			       FROM auth_accounts a
			       JOIN auth_memberships m ON m.account_id = a.id
			       WHERE a.id = $1 AND m.tenant_id = $2`,
			parameters: [accountId, tenantId],
		});
		const row = result.rows[0];
		return row ? this.#credential(transaction, row) : null;
	}

	async isTenantSlugTaken(slug: string): Promise<boolean> {
		const rows = await this.#route<{ id: string }>({
			text: 'SELECT id FROM auth_tenants WHERE slug = $1 LIMIT 1',
			parameters: [slug],
		});
		return rows.length > 0;
	}

	async findTenant(reference: string): Promise<TenantSummary | null> {
		const rows = await this.#route<TenantRow>({
			text: `SELECT id, name, slug FROM auth_tenants
			       WHERE id = $1 OR slug = $1 LIMIT 1`,
			parameters: [reference],
		});
		return rows[0] ? tenantSummary(rows[0]) : null;
	}

	async listTenants(): Promise<readonly TenantSummary[]> {
		const rows = await this.#route<TenantRow>({
			text: 'SELECT id, name, slug FROM auth_tenants ORDER BY name, id',
		});
		return rows.map(tenantSummary);
	}

	async renameTenant(
		tenantId: string,
		name: string,
	): Promise<TenantSummary | null> {
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<TenantRow>({
				text: `UPDATE auth_tenants SET name = $1 WHERE id = $2
				       RETURNING id, name, slug`,
				parameters: [name, tenantId],
			});
			return result.rows;
		});
		return rows[0] ? tenantSummary(rows[0]) : null;
	}

	async listOwnerMemberships(): Promise<
		readonly { readonly accountId: string; readonly tenantId: string }[]
	> {
		const rows = await this.#route<{ account_id: string; tenant_id: string }>({
			text: `SELECT account_id, tenant_id FROM auth_memberships
			       WHERE role = 'owner' ORDER BY tenant_id, account_id`,
		});
		return rows.map((row) => ({
			accountId: row.account_id,
			tenantId: row.tenant_id,
		}));
	}

	/* Sign-in knows an email address and nothing else. The account row is
	   identity, not workspace data, so it is read under the identity context;
	   only the workspace the credential belongs to needs the routing read. */
	async findAccountByEmail(
		normalizedEmail: string,
	): Promise<AccountCredential | null> {
		const accounts = await this.#query<{ id: string }>(
			IDENTITY_TENANT_CONTEXT,
			{
				text: 'SELECT id FROM auth_accounts WHERE email_normalized = $1',
				parameters: [normalizedEmail],
			},
		);
		const accountId = accounts[0]?.id;
		return accountId ? this.findAccountCredentialById(accountId) : null;
	}

	async findAccountIdentity(
		normalizedEmail: string,
	): Promise<AccountIdentity | null> {
		const rows = await this.#query<{
			id: string;
			email: string;
			display_name: string;
			status: 'active' | 'disabled';
		}>(IDENTITY_TENANT_CONTEXT, {
			text: `SELECT id, email, display_name, status FROM auth_accounts
			       WHERE email_normalized = $1`,
			parameters: [normalizedEmail],
		});
		const row = rows[0];
		return row
			? {
					accountId: row.id,
					email: row.email,
					displayName: row.display_name,
					status: row.status,
				}
			: null;
	}

	async findAccountCredentialById(
		accountId: string,
	): Promise<AccountCredential | null> {
		const tenantId = await this.#tenantOfAccount(accountId);
		return tenantId ? this.findAccountMembership(accountId, tenantId) : null;
	}

	async findAccountMembership(
		accountId: string,
		tenantId: string,
	): Promise<AccountCredential | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#membership(transaction, accountId, tenantId),
		);
	}

	async updatePasswordHash(
		accountId: string,
		passwordHash: string,
		changeRequired: boolean,
	): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: `UPDATE auth_accounts SET password_hash = $1,
			       password_change_required = $2 WHERE id = $3`,
			parameters: [passwordHash, changeRequired ? 1 : 0, accountId],
		});
	}

	async updateAccountDisplayName(
		accountId: string,
		displayName: string,
	): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: 'UPDATE auth_accounts SET display_name = $1 WHERE id = $2',
			parameters: [displayName, accountId],
		});
	}

	async updateAccountStatus(
		accountId: string,
		status: 'active' | 'disabled',
	): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: 'UPDATE auth_accounts SET status = $1 WHERE id = $2',
			parameters: [status, accountId],
		});
	}

	/* A credential change invalidates every other session of that account, in
	   every workspace it can enter. Row security scopes a delete to one
	   workspace, so the sessions are routed first and removed per tenant. */
	async deleteAccountSessions(
		accountId: string,
		exceptTokenHash: string | null,
	): Promise<void> {
		const tenants = await this.#route<RoutedTenantRow>({
			text: 'SELECT DISTINCT tenant_id FROM auth_sessions WHERE account_id = $1',
			parameters: [accountId],
		});
		for (const row of tenants) {
			await this.#exec(
				row.tenant_id,
				exceptTokenHash
					? {
							text: `DELETE FROM auth_sessions
							       WHERE account_id = $1 AND token_hash <> $2`,
							parameters: [accountId, exceptTokenHash],
						}
					: {
							text: 'DELETE FROM auth_sessions WHERE account_id = $1',
							parameters: [accountId],
						},
			);
		}
	}

	async deleteMembershipSessions(
		accountId: string,
		tenantId: string,
	): Promise<void> {
		await this.#exec(tenantId, {
			text: 'DELETE FROM auth_sessions WHERE account_id = $1 AND tenant_id = $2',
			parameters: [accountId, tenantId],
		});
	}

	async deleteMembership(
		accountId: string,
		tenantId: string,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			await transaction.execute({
				text: `DELETE FROM auth_sessions
				       WHERE account_id = $1 AND tenant_id = $2`,
				parameters: [accountId, tenantId],
			});
			const result = await transaction.execute({
				text: `DELETE FROM auth_memberships
				       WHERE account_id = $1 AND tenant_id = $2`,
				parameters: [accountId, tenantId],
			});
			return result.affectedRows > 0;
		});
	}

	async countMemberships(accountId: string): Promise<number> {
		const rows = await this.#route<CountRow>({
			text: 'SELECT count(*) AS total FROM auth_memberships WHERE account_id = $1',
			parameters: [accountId],
		});
		return rows[0] ? integer(rows[0].total) : 0;
	}

	/* The account row is the identity. Its memberships, sessions and tokens go
	   with it: referential actions are not subject to row security, so the
	   cascade reaches every workspace the account belonged to. */
	async deleteAccount(accountId: string): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: 'DELETE FROM auth_accounts WHERE id = $1',
			parameters: [accountId],
		});
	}

	async countActiveOwners(tenantId: string): Promise<number> {
		const rows = await this.#query<CountRow>(tenantId, {
			text: `SELECT count(*) AS total FROM auth_memberships m
			       JOIN auth_accounts a ON a.id = m.account_id
			       WHERE m.tenant_id = $1 AND m.role = 'owner'
			         AND a.status = 'active' AND m.status = 'active'`,
			parameters: [tenantId],
		});
		return rows[0] ? integer(rows[0].total) : 0;
	}

	/* Which workspaces an account may enter is the one question that spans
	   them all, so it is answered on the cross-tenant handle. */
	async listTenantAccess(
		accountId: string,
	): Promise<readonly AuthTenantAccess[]> {
		const rows = await this.#route<TenantAccessRow>({
			text: `SELECT t.id AS tenant_id, t.name, t.slug, m.role
			       FROM auth_memberships m
			       JOIN auth_tenants t ON t.id = m.tenant_id
			       WHERE m.account_id = $1 AND m.status = 'active'
			       ORDER BY m.created_at, t.id`,
			parameters: [accountId],
		});
		return rows.map((row) => ({
			tenantId: row.tenant_id,
			name: row.name,
			slug: row.slug,
			role: row.role,
		}));
	}

	async listTenantMembers(tenantId: string): Promise<readonly TenantMember[]> {
		const rows = await this.#query<TenantMemberRow>(tenantId, {
			text: `SELECT ${TENANT_MEMBER_COLUMNS}
			       FROM auth_memberships m
			       JOIN auth_accounts a ON a.id = m.account_id
			       WHERE m.tenant_id = $1
			       ORDER BY lower(a.display_name), a.id`,
			parameters: [tenantId],
		});
		return rows.map(tenantMemberFrom);
	}

	/* Keyset by account id, which migration 0030 indexes behind the workspace,
	   so a page is an index range scan of exactly the rows it returns rather
	   than a walk over every workspace's memberships after the cursor. */
	async listTenantMembersPage(
		tenantId: string,
		afterAccountId: string,
		limit: number,
	): Promise<readonly TenantMember[]> {
		const rows = await this.#query<TenantMemberRow>(tenantId, {
			text: `SELECT ${TENANT_MEMBER_COLUMNS}
			       FROM auth_memberships m
			       JOIN auth_accounts a ON a.id = m.account_id
			       WHERE m.tenant_id = $1 AND m.account_id > $2
			       ORDER BY m.account_id
			       LIMIT $3`,
			parameters: [tenantId, afterAccountId, limit],
		});
		return rows.map(tenantMemberFrom);
	}

	async findTenantMember(
		tenantId: string,
		accountId: string,
	): Promise<TenantMember | null> {
		const rows = await this.#query<TenantMemberRow>(tenantId, {
			text: `SELECT ${TENANT_MEMBER_COLUMNS}
			       FROM auth_memberships m
			       JOIN auth_accounts a ON a.id = m.account_id
			       WHERE m.tenant_id = $1 AND m.account_id = $2`,
			parameters: [tenantId, accountId],
		});
		const row = rows[0];
		return row ? tenantMemberFrom(row) : null;
	}

	async findTenantMembersByEmail(
		tenantId: string,
		normalizedEmails: readonly string[],
	): Promise<readonly TenantMember[]> {
		if (normalizedEmails.length === 0) return [];
		const rows = await this.#query<TenantMemberRow>(tenantId, {
			text: `SELECT ${TENANT_MEMBER_COLUMNS}
			       FROM auth_memberships m
			       JOIN auth_accounts a ON a.id = m.account_id
			       WHERE m.tenant_id = $1 AND a.email_normalized = ANY($2::text[])
			       ORDER BY lower(a.display_name), a.id`,
			parameters: [tenantId, textArrayLiteral(normalizedEmails)],
		});
		return rows.map(tenantMemberFrom);
	}

	async searchTenantMembers(
		tenantId: string,
		term: string,
		limit: number,
	): Promise<readonly TenantMember[]> {
		const rows = await this.#query<TenantMemberRow>(tenantId, {
			text: TENANT_MEMBER_SEARCH_SQL,
			parameters: [tenantId, `${term}%`, limit],
		});
		return rows.map(tenantMemberFrom);
	}

	async listTenantScopes(tenantId: string): Promise<readonly string[]> {
		const rows = await this.#query<ScopeRow>(tenantId, {
			text: `SELECT DISTINCT scope FROM auth_membership_scopes
			       WHERE tenant_id = $1 ORDER BY scope`,
			parameters: [tenantId],
		});
		return rows.map((row) => row.scope);
	}

	async createAccountWithTenant(
		record: CreateAccountRecord,
	): Promise<AccountCredential> {
		try {
			return await this.#tx(record.tenantId, 'write', async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ($1, $2, $3, $4)`,
					parameters: [
						record.tenantId,
						record.organizationName,
						record.organizationSlug,
						record.createdAt,
					],
				});
				await this.#seedBuiltinRoles(
					transaction,
					record.tenantId,
					record.createdAt,
				);
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
					parameters: [
						record.accountId,
						record.email,
						record.normalizedEmail,
						record.passwordHash,
						record.displayName,
						record.createdAt,
					],
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships
					       (account_id, tenant_id, role, role_id, created_at)
					       VALUES ($1, $2, $3, $4, $5)`,
					parameters: [
						record.accountId,
						record.tenantId,
						record.role,
						builtinRoleId(record.tenantId, record.role),
						record.createdAt,
					],
				});
				await this.#insertScopes(
					transaction,
					record.accountId,
					record.tenantId,
					record.scopes,
				);
				return (await this.#membership(
					transaction,
					record.accountId,
					record.tenantId,
				))!;
			});
		} catch (error) {
			const conflict = duplicate(error);
			if (conflict === 'email') throw new DuplicateAccountError();
			if (conflict === 'slug') throw new DuplicateTenantSlugError();
			throw error;
		}
	}

	async createAccountInTenant(
		record: CreateAccountInTenantRecord,
	): Promise<AccountCredential> {
		try {
			return await this.#tx(record.tenantId, 'write', async (transaction) => {
				const scopes = await this.#assignedScopes(
					transaction,
					record.tenantId,
					record.role,
					record.scopes,
				);
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
					parameters: [
						record.accountId,
						record.email,
						record.normalizedEmail,
						record.passwordHash,
						record.displayName,
						record.createdAt,
					],
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships
					       (account_id, tenant_id, role, role_id, created_at)
					       VALUES ($1, $2, $3, $4, $5)`,
					parameters: [
						record.accountId,
						record.tenantId,
						record.role,
						record.roleId,
						record.createdAt,
					],
				});
				await this.#insertScopes(
					transaction,
					record.accountId,
					record.tenantId,
					scopes,
				);
				return (await this.#membership(
					transaction,
					record.accountId,
					record.tenantId,
				))!;
			});
		} catch (error) {
			if (duplicate(error) === 'email') throw new DuplicateAccountError();
			throw error;
		}
	}

	async createTenantMembership(
		record: CreateTenantMembershipRecord,
	): Promise<AccountCredential> {
		try {
			return await this.#tx(record.tenantId, 'write', async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ($1, $2, $3, $4)`,
					parameters: [
						record.tenantId,
						record.organizationName,
						record.organizationSlug,
						record.createdAt,
					],
				});
				await this.#seedBuiltinRoles(
					transaction,
					record.tenantId,
					record.createdAt,
				);
				await transaction.execute({
					text: `INSERT INTO auth_memberships
					       (account_id, tenant_id, role, role_id, created_at)
					       VALUES ($1, $2, $3, $4, $5)`,
					parameters: [
						record.accountId,
						record.tenantId,
						record.role,
						builtinRoleId(record.tenantId, record.role),
						record.createdAt,
					],
				});
				await this.#insertScopes(
					transaction,
					record.accountId,
					record.tenantId,
					record.scopes,
				);
				return (await this.#membership(
					transaction,
					record.accountId,
					record.tenantId,
				))!;
			});
		} catch (error) {
			if (duplicate(error) === 'slug') throw new DuplicateTenantSlugError();
			throw error;
		}
	}

	async createMembershipInTenant(record: {
		readonly accountId: string;
		readonly tenantId: string;
		readonly role: string;
		readonly roleId: string | null;
		readonly scopes: readonly string[];
		readonly createdAt: number;
	}): Promise<AccountCredential> {
		return this.#tx(record.tenantId, 'write', async (transaction) => {
			const scopes = await this.#assignedScopes(
				transaction,
				record.tenantId,
				record.role,
				record.scopes,
			);
			await transaction.execute({
				text: `INSERT INTO auth_memberships
				       (account_id, tenant_id, role, role_id, created_at)
				       VALUES ($1, $2, $3, $4, $5)`,
				parameters: [
					record.accountId,
					record.tenantId,
					record.role,
					record.roleId,
					record.createdAt,
				],
			});
			await this.#insertScopes(
				transaction,
				record.accountId,
				record.tenantId,
				scopes,
			);
			return (await this.#membership(
				transaction,
				record.accountId,
				record.tenantId,
			))!;
		});
	}

	async createApiToken(record: CreateApiTokenRecord): Promise<ApiTokenRecord> {
		const rows = await this.#tx(
			record.tenantId,
			'write',
			async (transaction) => {
				const result = await transaction.query<ApiTokenRow>({
					text: `INSERT INTO auth_api_tokens
				       (id, tenant_id, account_id, label, prefix, token_hash, scopes_json,
				        created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by)
				       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL)
				       RETURNING *`,
					parameters: [
						record.id,
						record.tenantId,
						record.accountId,
						record.label,
						record.prefix,
						record.tokenHash,
						JSON.stringify(record.scopes),
						record.createdBy,
						record.createdAt,
						record.expiresAt,
					],
				});
				return result.rows;
			},
		);
		return fromApiTokenRow(rows[0]!);
	}

	async listApiTokens(tenantId: string): Promise<readonly ApiTokenRecord[]> {
		const rows = await this.#query<ApiTokenRow>(tenantId, {
			text: `SELECT * FROM auth_api_tokens WHERE tenant_id = $1
			       ORDER BY (revoked_at IS NOT NULL), created_at DESC, id`,
			parameters: [tenantId],
		});
		return rows.map(fromApiTokenRow);
	}

	/* A bearer token names no workspace. The routing read hands back the tenant
	   that owns it, and the record itself is read under that tenant. A revoked
	   token routes nowhere, which is the same answer an unknown token gets. */
	async findApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
		const routed = await this.#route<RoutedTenantRow>({
			text: `SELECT tenant_id FROM auth_api_tokens
			       WHERE token_hash = $1 AND revoked_at IS NULL`,
			parameters: [tokenHash],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return null;
		const rows = await this.#query<ApiTokenRow>(tenantId, {
			text: 'SELECT * FROM auth_api_tokens WHERE token_hash = $1',
			parameters: [tokenHash],
		});
		return rows[0] ? fromApiTokenRow(rows[0]) : null;
	}

	async touchApiToken(
		tenantId: string,
		id: string,
		usedAt: number,
	): Promise<void> {
		await this.#exec(tenantId, {
			text: 'UPDATE auth_api_tokens SET last_used_at = $1 WHERE id = $2',
			parameters: [usedAt, id],
		});
	}

	async revokeApiToken(
		tenantId: string,
		id: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<ApiTokenRecord | null> {
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			await transaction.execute({
				text: `UPDATE auth_api_tokens SET revoked_at = $1, revoked_by = $2
				       WHERE tenant_id = $3 AND id = $4 AND revoked_at IS NULL`,
				parameters: [revokedAt, revokedBy, tenantId, id],
			});
			const result = await transaction.query<ApiTokenRow>({
				text: 'SELECT * FROM auth_api_tokens WHERE tenant_id = $1 AND id = $2',
				parameters: [tenantId, id],
			});
			return result.rows;
		});
		return rows[0] ? fromApiTokenRow(rows[0]) : null;
	}

	async insertMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<void> {
		const statement = scopeRows(accountId, tenantId, scopes);
		if (statement) await this.#exec(tenantId, statement);
	}

	async grantTenantOwnerScopes(
		tenantId: string,
		scopes: readonly string[],
		updatedAt: number,
	): Promise<
		readonly {
			readonly accountId: string;
			readonly granted: readonly string[];
		}[]
	> {
		if (scopes.length === 0) return [];
		return this.#tx(tenantId, 'write', async (transaction) => {
			/* Serialize concurrent module grants before reading the role ceiling. */
			const roles = await transaction.query<RoleRow>({
				text: `SELECT * FROM auth_roles
				       WHERE tenant_id = $1 AND key = 'owner' AND builtin = 1 FOR UPDATE`,
				parameters: [tenantId],
			});
			const role = roles.rows[0];
			if (!role) throw new Error('The workspace has no built-in owner role.');
			const held = fromRoleRow(role).scopes;
			const combined = [...new Set([...held, ...scopes])].sort();
			if (combined.length !== new Set(held).size) {
				await transaction.execute({
					text: `UPDATE auth_roles SET scopes_json = $1, updated_at = $2
					       WHERE tenant_id = $3 AND id = $4`,
					parameters: [JSON.stringify(combined), updatedAt, tenantId, role.id],
				});
			}
			const inserted = await transaction.query<{
				account_id: string;
				scope: string;
			}>({
				text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
				       SELECT m.account_id, m.tenant_id, s.scope
				       FROM auth_memberships m
				       CROSS JOIN jsonb_array_elements_text($2::jsonb) AS s(scope)
				       WHERE m.tenant_id = $1 AND m.role = 'owner'
				       ON CONFLICT DO NOTHING RETURNING account_id, scope`,
				parameters: [tenantId, JSON.stringify([...new Set(scopes)])],
			});
			const granted = new Map<string, string[]>();
			for (const row of inserted.rows) {
				const values = granted.get(row.account_id) ?? [];
				values.push(row.scope);
				granted.set(row.account_id, values);
			}
			return [...granted]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([accountId, values]) => ({ accountId, granted: values.sort() }));
		});
	}

	async replaceMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			await transaction.execute({
				text: `DELETE FROM auth_membership_scopes
				       WHERE account_id = $1 AND tenant_id = $2`,
				parameters: [accountId, tenantId],
			});
			await this.#insertScopes(transaction, accountId, tenantId, scopes);
		});
	}

	async updateMembershipRole(
		accountId: string,
		tenantId: string,
		role: string,
		roleId: string | null,
		scopes: readonly string[],
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			const assignedScopes = await this.#assignedScopes(
				transaction,
				tenantId,
				role,
				scopes,
			);
			await transaction.execute({
				text: `UPDATE auth_memberships SET role = $1, role_id = $2
				       WHERE account_id = $3 AND tenant_id = $4`,
				parameters: [role, roleId, accountId, tenantId],
			});
			await transaction.execute({
				text: `DELETE FROM auth_membership_scopes
				       WHERE account_id = $1 AND tenant_id = $2`,
				parameters: [accountId, tenantId],
			});
			await this.#insertScopes(
				transaction,
				accountId,
				tenantId,
				assignedScopes,
			);
		});
	}

	async createSession(record: CreateSessionRecord): Promise<void> {
		await this.#exec(record.tenantId, {
			text: `INSERT INTO auth_sessions
			       (id, token_hash, account_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at)
			       VALUES ($1, $2, $3, $4, $5, $6, $7, $6)`,
			parameters: [
				record.id,
				record.tokenHash,
				record.accountId,
				record.tenantId,
				record.csrfToken,
				record.createdAt,
				record.expiresAt,
			],
		});
	}

	/* The cookie names its workspace only through the session row, so the
	   tenant is routed first and the session, the account and the scopes are
	   then read in one transaction under it. */
	async findSession(
		tokenHash: string,
		now: number,
		idleMs: number,
		touchIntervalMs: number,
	): Promise<AuthSession | null> {
		const routed = await this.#route<RoutedTenantRow>({
			text: 'SELECT tenant_id FROM auth_sessions WHERE token_hash = $1',
			parameters: [tokenHash],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return null;
		const session = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<SessionRow>({
				text: `SELECT ${ACCOUNT_COLUMNS}, s.id AS session_id, s.csrf_token,
				       s.expires_at, s.last_seen_at
				       FROM auth_sessions s
				       JOIN auth_accounts a ON a.id = s.account_id
				       JOIN auth_memberships m
				         ON m.account_id = s.account_id AND m.tenant_id = s.tenant_id
				       WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.status = 'active'
				         AND m.status = 'active'`,
				parameters: [tokenHash, now],
			});
			const row = result.rows[0];
			if (!row) return null;
			const lastSeenAt = integer(row.last_seen_at);
			if (now - lastSeenAt > idleMs) {
				await transaction.execute({
					text: 'DELETE FROM auth_sessions WHERE token_hash = $1',
					parameters: [tokenHash],
				});
				return null;
			}
			if (now - lastSeenAt >= touchIntervalMs) {
				await transaction.execute({
					text: 'UPDATE auth_sessions SET last_seen_at = $1 WHERE token_hash = $2',
					parameters: [now, tokenHash],
				});
			}
			return {
				row,
				scopes: await this.#scopes(transaction, row.account_id, tenantId),
			};
		});
		if (!session) return null;
		const principal: AuthPrincipal = {
			accountId: session.row.account_id,
			tenantId: session.row.tenant_id,
			email: session.row.email,
			displayName: session.row.display_name,
			role: session.row.role,
			scopes: session.scopes,
			tenants: await this.listTenantAccess(session.row.account_id),
		};
		return {
			principal,
			csrfToken: session.row.csrf_token,
			expiresAt: integer(session.row.expires_at),
			sessionId: session.row.session_id,
			passwordChangeRequired:
				integer(session.row.password_change_required) === 1,
		};
	}

	/* An account sees its sessions in every workspace it can enter, and row
	   security scopes each read to one, so the workspaces are routed first. */
	async listAccountSessions(
		accountId: string,
		now: number,
	): Promise<readonly SessionSummary[]> {
		const tenants = await this.#route<RoutedTenantRow>({
			text: `SELECT DISTINCT tenant_id FROM auth_sessions
			       WHERE account_id = $1 AND expires_at > $2`,
			parameters: [accountId, now],
		});
		const summaries: SessionSummary[] = [];
		for (const tenant of tenants) {
			const rows = await this.#query<SessionSummaryRow>(tenant.tenant_id, {
				text: `SELECT s.id, s.tenant_id, t.name AS tenant_name, s.created_at,
				       s.last_seen_at, s.expires_at
				       FROM auth_sessions s
				       JOIN auth_tenants t ON t.id = s.tenant_id
				       WHERE s.account_id = $1 AND s.expires_at > $2`,
				parameters: [accountId, now],
			});
			for (const row of rows) {
				summaries.push({
					id: row.id,
					tenantId: row.tenant_id,
					tenantName: row.tenant_name,
					createdAt: integer(row.created_at),
					lastSeenAt: integer(row.last_seen_at),
					expiresAt: integer(row.expires_at),
				});
			}
		}
		return summaries.sort(
			(left, right) =>
				right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id),
		);
	}

	async deleteSession(tokenHash: string): Promise<void> {
		const routed = await this.#route<RoutedTenantRow>({
			text: 'SELECT tenant_id FROM auth_sessions WHERE token_hash = $1',
			parameters: [tokenHash],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return;
		await this.#exec(tenantId, {
			text: 'DELETE FROM auth_sessions WHERE token_hash = $1',
			parameters: [tokenHash],
		});
	}

	async deleteSessionById(accountId: string, id: string): Promise<boolean> {
		const routed = await this.#route<RoutedTenantRow>({
			text: `SELECT tenant_id FROM auth_sessions
			       WHERE account_id = $1 AND id = $2`,
			parameters: [accountId, id],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return false;
		const affected = await this.#exec(tenantId, {
			text: 'DELETE FROM auth_sessions WHERE account_id = $1 AND id = $2',
			parameters: [accountId, id],
		});
		return affected > 0;
	}

	/**
	 * Removes sessions that expired before `now` in batches of
	 * EXPIRED_SESSION_SWEEP_BATCH, at most `maxBatches` of them, and answers how
	 * many rows went. A backlog of unknown size must not become one delete that
	 * holds the table for the length of it, and what the bound leaves behind is
	 * the next pass's work. Row security scopes a delete to one workspace, so
	 * the rows are routed first and removed per tenant.
	 */
	async deleteExpiredSessions(
		now: number,
		maxBatches: number = Number.POSITIVE_INFINITY,
	): Promise<number> {
		const tenants = await this.#route<RoutedTenantRow>({
			text: 'SELECT DISTINCT tenant_id FROM auth_sessions WHERE expires_at <= $1',
			parameters: [now],
		});
		let removed = 0;
		let batches = 0;
		for (const tenant of tenants) {
			while (batches < maxBatches) {
				batches += 1;
				const gone = await this.#exec(tenant.tenant_id, {
					text: `DELETE FROM auth_sessions
					       WHERE id IN (SELECT id FROM auth_sessions
					                    WHERE expires_at <= $1
					                    LIMIT $2)`,
					parameters: [now, EXPIRED_SESSION_SWEEP_BATCH],
				});
				removed += gone;
				/* A short batch is the proof this workspace is drained. */
				if (gone < EXPIRED_SESSION_SWEEP_BATCH) break;
			}
		}
		return removed;
	}

	async createPasswordResetToken(
		record: PasswordResetTokenRecord,
	): Promise<void> {
		await this.#tx(IDENTITY_TENANT_CONTEXT, 'write', async (transaction) => {
			await transaction.execute({
				text: `DELETE FROM auth_password_reset_tokens
				       WHERE account_id = $1 OR expires_at <= $2`,
				parameters: [record.accountId, record.createdAt],
			});
			await transaction.execute({
				text: `INSERT INTO auth_password_reset_tokens
				       (token_hash, account_id, expires_at, used_at, created_at)
				       VALUES ($1, $2, $3, NULL, $4)`,
				parameters: [
					record.tokenHash,
					record.accountId,
					record.expiresAt,
					record.createdAt,
				],
			});
		});
	}

	/* Reads the account a live link names so the password policy can run on the
	   full account before anything spends the token. Claiming it stays the job
	   of consumePasswordResetToken below. */
	async findPasswordResetTokenAccount(
		tokenHash: string,
		now: number,
	): Promise<string | null> {
		const rows = await this.#query<{ account_id: string }>(
			IDENTITY_TENANT_CONTEXT,
			{
				text: `SELECT account_id FROM auth_password_reset_tokens
				       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
				parameters: [tokenHash, now],
			},
		);
		return rows[0]?.account_id ?? null;
	}

	/* One statement claims the token: a second caller with the same link finds
	   used_at already set and gets nothing. */
	async consumePasswordResetToken(
		tokenHash: string,
		now: number,
	): Promise<string | null> {
		const rows = await this.#tx(
			IDENTITY_TENANT_CONTEXT,
			'write',
			async (transaction) => {
				const result = await transaction.query<{ account_id: string }>({
					text: `UPDATE auth_password_reset_tokens SET used_at = $1
					       WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1
					       RETURNING account_id`,
					parameters: [now, tokenHash],
				});
				return result.rows;
			},
		);
		return rows[0]?.account_id ?? null;
	}

	async createTenantInvitation(record: TenantInvitationRecord): Promise<void> {
		await this.#tx(record.tenantId, 'write', async (transaction) => {
			await transaction.execute({
				text: `DELETE FROM auth_tenant_invitations
				       WHERE tenant_id = $1 AND email_normalized = $2`,
				parameters: [record.tenantId, record.normalizedEmail],
			});
			await transaction.execute({
				text: `INSERT INTO auth_tenant_invitations
				       (id, tenant_id, email, email_normalized, role_key, token_hash,
				        expires_at, accepted_at, created_by, created_at)
				       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9)`,
				parameters: [
					record.id,
					record.tenantId,
					record.email,
					record.normalizedEmail,
					record.roleKey,
					record.tokenHash,
					record.expiresAt,
					record.createdBy,
					record.createdAt,
				],
			});
		});
	}

	async consumeTenantInvitation(
		tokenHash: string,
		now: number,
	): Promise<{
		readonly tenantId: string;
		readonly email: string;
		readonly normalizedEmail: string;
		readonly roleKey: string;
	} | null> {
		const routed = await this.#route<RoutedTenantRow>({
			text: 'SELECT tenant_id FROM auth_tenant_invitations WHERE token_hash = $1',
			parameters: [tokenHash],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return null;
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<{
				tenant_id: string;
				email: string;
				email_normalized: string;
				role_key: string;
			}>({
				text: `UPDATE auth_tenant_invitations SET accepted_at = $1
				       WHERE token_hash = $2 AND accepted_at IS NULL AND expires_at > $1
				       RETURNING tenant_id, email, email_normalized, role_key`,
				parameters: [now, tokenHash],
			});
			return result.rows;
		});
		const row = rows[0];
		return row
			? {
					tenantId: row.tenant_id,
					email: row.email,
					normalizedEmail: row.email_normalized,
					roleKey: row.role_key,
				}
			: null;
	}

	async upsertMfaTotp(
		accountId: string,
		secret: SealedMfaSecret,
		createdAt: number,
	): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: `INSERT INTO auth_mfa_totp
			       (account_id, secret_ciphertext, key_id, confirmed_at, created_at)
			       VALUES ($1, $2, $3, NULL, $4)
			       ON CONFLICT (account_id) DO UPDATE SET
			         secret_ciphertext = excluded.secret_ciphertext,
			         key_id = excluded.key_id,
			         confirmed_at = NULL,
			         created_at = excluded.created_at`,
			parameters: [accountId, secret.ciphertext, secret.keyId, createdAt],
		});
	}

	async findMfaTotp(accountId: string): Promise<{
		readonly secretCiphertext: string;
		readonly keyId: string | null;
		readonly confirmedAt: number | null;
	} | null> {
		const rows = await this.#query<{
			secret_ciphertext: string;
			key_id: string | null;
			confirmed_at: number | bigint | string | null;
		}>(IDENTITY_TENANT_CONTEXT, {
			text: `SELECT secret_ciphertext, key_id, confirmed_at FROM auth_mfa_totp
			       WHERE account_id = $1`,
			parameters: [accountId],
		});
		const row = rows[0];
		return row
			? {
					secretCiphertext: row.secret_ciphertext,
					keyId: row.key_id,
					confirmedAt: optionalInteger(row.confirmed_at),
				}
			: null;
	}

	async hasConfirmedMfaTotp(accountId: string): Promise<boolean> {
		const rows = await this.#query<{ account_id: string }>(
			IDENTITY_TENANT_CONTEXT,
			{
				text: `SELECT account_id FROM auth_mfa_totp
				       WHERE account_id = $1 AND confirmed_at IS NOT NULL`,
				parameters: [accountId],
			},
		);
		return rows.length > 0;
	}

	async confirmMfaTotp(accountId: string, confirmedAt: number): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: 'UPDATE auth_mfa_totp SET confirmed_at = $1 WHERE account_id = $2',
			parameters: [confirmedAt, accountId],
		});
	}

	async deleteMfaEnrolment(accountId: string): Promise<void> {
		await this.#tx(IDENTITY_TENANT_CONTEXT, 'write', async (transaction) => {
			await transaction.execute({
				text: 'DELETE FROM auth_mfa_totp WHERE account_id = $1',
				parameters: [accountId],
			});
			await transaction.execute({
				text: 'DELETE FROM auth_mfa_recovery_codes WHERE account_id = $1',
				parameters: [accountId],
			});
		});
	}

	async replaceMfaRecoveryCodes(
		accountId: string,
		codeHashes: readonly string[],
		createdAt: number,
	): Promise<void> {
		await this.#tx(IDENTITY_TENANT_CONTEXT, 'write', async (transaction) => {
			await transaction.execute({
				text: 'DELETE FROM auth_mfa_recovery_codes WHERE account_id = $1',
				parameters: [accountId],
			});
			for (const codeHash of codeHashes) {
				await transaction.execute({
					text: `INSERT INTO auth_mfa_recovery_codes
					       (code_hash, account_id, used_at, created_at)
					       VALUES ($1, $2, NULL, $3)`,
					parameters: [codeHash, accountId, createdAt],
				});
			}
		});
	}

	async consumeMfaRecoveryCode(
		accountId: string,
		codeHash: string,
	): Promise<boolean> {
		const affected = await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: `UPDATE auth_mfa_recovery_codes
			       SET used_at = (extract(epoch FROM now()) * 1000)::bigint
			       WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL`,
			parameters: [accountId, codeHash],
		});
		return affected === 1;
	}

	/* Expired challenges of the same workspace are dropped on the way in, so
	   the table stays bounded by recent sign-in activity. */
	async createMfaChallenge(record: MfaChallengeRecord): Promise<void> {
		await this.#tx(record.tenantId, 'write', async (transaction) => {
			await transaction.execute({
				text: 'DELETE FROM auth_mfa_challenges WHERE expires_at <= $1',
				parameters: [record.createdAt],
			});
			await transaction.execute({
				text: `INSERT INTO auth_mfa_challenges
				       (token_hash, account_id, tenant_id, expires_at, used_at, created_at)
				       VALUES ($1, $2, $3, $4, NULL, $5)`,
				parameters: [
					record.tokenHash,
					record.accountId,
					record.tenantId,
					record.expiresAt,
					record.createdAt,
				],
			});
		});
	}

	async consumeMfaChallenge(
		tokenHash: string,
		now: number,
	): Promise<{ readonly accountId: string; readonly tenantId: string } | null> {
		const routed = await this.#route<RoutedTenantRow>({
			text: 'SELECT tenant_id FROM auth_mfa_challenges WHERE token_hash = $1',
			parameters: [tokenHash],
		});
		const tenantId = routed[0]?.tenant_id;
		if (!tenantId) return null;
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<{
				account_id: string;
				tenant_id: string;
			}>({
				text: `UPDATE auth_mfa_challenges SET used_at = $1
				       WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1
				       RETURNING account_id, tenant_id`,
				parameters: [now, tokenHash],
			});
			return result.rows;
		});
		const row = rows[0];
		return row ? { accountId: row.account_id, tenantId: row.tenant_id } : null;
	}

	/* A binding lives in one space: the platform space, whose rows carry no
	   workspace and are read under the identity context exactly as before, or
	   one workspace's space, read and written under that workspace. The policy
	   on the table enforces the same split. */
	async findExternalIdentity(
		provider: string,
		subject: string,
		tenantId: string | null = null,
	): Promise<string | null> {
		const rows = await this.#query<{ account_id: string }>(
			tenantId ?? IDENTITY_TENANT_CONTEXT,
			{
				text: `SELECT account_id FROM auth_external_identities
				       WHERE provider = $1 AND subject = $2
				         AND tenant_id IS NOT DISTINCT FROM $3`,
				parameters: [provider, subject, tenantId],
			},
		);
		return rows[0]?.account_id ?? null;
	}

	async findExternalIdentitySubject(
		provider: string,
		accountId: string,
		tenantId: string | null = null,
	): Promise<string | null> {
		const rows = await this.#query<{ subject: string }>(
			tenantId ?? IDENTITY_TENANT_CONTEXT,
			{
				text: `SELECT subject FROM auth_external_identities
				       WHERE account_id = $1 AND provider = $2
				         AND tenant_id IS NOT DISTINCT FROM $3`,
				parameters: [accountId, provider, tenantId],
			},
		);
		return rows[0]?.subject ?? null;
	}

	async linkExternalIdentity(record: ExternalIdentityRecord): Promise<void> {
		const tenantId = record.tenantId ?? null;
		await this.#exec(tenantId ?? IDENTITY_TENANT_CONTEXT, {
			text: tenantId
				? `INSERT INTO auth_external_identities
				   (provider, subject, account_id, tenant_id, created_at, last_seen_at)
				   VALUES ($1, $2, $3, $4, $5, $5)
				   ON CONFLICT (tenant_id, provider, subject) WHERE tenant_id IS NOT NULL
				   DO UPDATE SET last_seen_at = excluded.last_seen_at`
				: `INSERT INTO auth_external_identities
				   (provider, subject, account_id, tenant_id, created_at, last_seen_at)
				   VALUES ($1, $2, $3, $4, $5, $5)
				   ON CONFLICT (provider, subject) WHERE tenant_id IS NULL
				   DO UPDATE SET last_seen_at = excluded.last_seen_at`,
			parameters: [
				record.provider,
				record.subject,
				record.accountId,
				tenantId,
				record.now,
			],
		});
	}

	/* Keyset by (provider, subject), which the unique workspace index covers in
	   that order, so a page is the rows it returns. The select list is the
	   binding and nothing else: no token, ciphertext, fingerprint or reported
	   address leaves this statement. A platform provider's binding carries no
	   workspace, so the predicate never reaches one. */
	async listExternalIdentitiesPage(
		tenantId: string,
		after: { readonly provider: string; readonly subject: string },
		limit: number,
	): Promise<readonly ExternalIdentityBinding[]> {
		const rows = await this.#query<ExternalIdentityBindingRow>(tenantId, {
			text: `SELECT account_id, provider, subject, created_at
			       FROM auth_external_identities
			       WHERE tenant_id = $1 AND (provider, subject) > ($2, $3)
			       ORDER BY provider, subject
			       LIMIT $4`,
			parameters: [tenantId, after.provider, after.subject, limit],
		});
		return rows.map((row) => ({
			accountId: row.account_id,
			provider: row.provider,
			subject: row.subject,
			linkedAt: integer(row.created_at),
		}));
	}

	/* A deleted provider takes its workspace's bindings with it; the accounts
	   stay and keep every other way of signing in. */
	async deleteExternalIdentitiesOfProvider(
		tenantId: string,
		provider: string,
	): Promise<void> {
		await this.#exec(tenantId, {
			text: `DELETE FROM auth_external_identities
			       WHERE tenant_id = $1 AND provider = $2`,
			parameters: [tenantId, provider],
		});
	}

	async listIdentityProviders(
		tenantId: string,
	): Promise<readonly IdentityProviderRecord[]> {
		const rows = await this.#query<IdentityProviderRow>(tenantId, {
			text: `SELECT * FROM auth_identity_providers
			       WHERE tenant_id = $1 ORDER BY key, id`,
			parameters: [tenantId],
		});
		return rows.map(fromIdentityProviderRow);
	}

	async findIdentityProvider(
		tenantId: string,
		id: string,
	): Promise<IdentityProviderRecord | null> {
		const rows = await this.#query<IdentityProviderRow>(tenantId, {
			text: 'SELECT * FROM auth_identity_providers WHERE tenant_id = $1 AND id = $2',
			parameters: [tenantId, id],
		});
		return rows[0] ? fromIdentityProviderRow(rows[0]) : null;
	}

	async findIdentityProviderByKey(
		tenantId: string,
		key: string,
	): Promise<IdentityProviderRecord | null> {
		const rows = await this.#query<IdentityProviderRow>(tenantId, {
			text: 'SELECT * FROM auth_identity_providers WHERE tenant_id = $1 AND key = $2',
			parameters: [tenantId, key],
		});
		return rows[0] ? fromIdentityProviderRow(rows[0]) : null;
	}

	async createIdentityProvider(
		record: IdentityProviderRecord,
	): Promise<IdentityProviderRecord> {
		try {
			const rows = await this.#tx(
				record.tenantId,
				'write',
				async (transaction) => {
					const result = await transaction.query<IdentityProviderRow>({
						text: `INSERT INTO auth_identity_providers
						       (id, tenant_id, key, label, issuer, authorization_endpoint,
						        token_endpoint, user_info_endpoint, client_id,
						        client_secret_ciphertext, client_secret_key_id,
						        client_secret_fingerprint, scopes_json, jit_enabled,
						        allowed_domains_json, jit_role, status, created_at, updated_at)
						       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
						               $14, $15, $16, $17, $18, $18)
						       RETURNING *`,
						parameters: [
							record.id,
							record.tenantId,
							record.key,
							record.label,
							record.issuer,
							record.authorizationEndpoint,
							record.tokenEndpoint,
							record.userInfoEndpoint,
							record.clientId,
							record.secretCiphertext,
							record.secretKeyId,
							record.secretFingerprint,
							JSON.stringify(record.scopes),
							record.jitEnabled ? 1 : 0,
							JSON.stringify(record.allowedDomains),
							record.jitRole,
							record.status,
							record.createdAt,
						],
					});
					return result.rows;
				},
			);
			return fromIdentityProviderRow(rows[0]!);
		} catch (error) {
			if (duplicate(error) === 'provider-key') {
				throw new DuplicateProviderKeyError();
			}
			throw error;
		}
	}

	async updateIdentityProvider(
		tenantId: string,
		id: string,
		patch: IdentityProviderPatch,
		updatedAt: number,
	): Promise<IdentityProviderRecord | null> {
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<IdentityProviderRow>({
				text: `UPDATE auth_identity_providers
				       SET label = $3, issuer = $4, authorization_endpoint = $5,
				           token_endpoint = $6, user_info_endpoint = $7, client_id = $8,
				           client_secret_ciphertext = $9, client_secret_key_id = $10,
				           client_secret_fingerprint = $11, scopes_json = $12,
				           jit_enabled = $13, allowed_domains_json = $14, jit_role = $15,
				           status = $16, updated_at = $17
				       WHERE tenant_id = $1 AND id = $2
				       RETURNING *`,
				parameters: [
					tenantId,
					id,
					patch.label,
					patch.issuer,
					patch.authorizationEndpoint,
					patch.tokenEndpoint,
					patch.userInfoEndpoint,
					patch.clientId,
					patch.secretCiphertext,
					patch.secretKeyId,
					patch.secretFingerprint,
					JSON.stringify(patch.scopes),
					patch.jitEnabled ? 1 : 0,
					JSON.stringify(patch.allowedDomains),
					patch.jitRole,
					patch.status,
					updatedAt,
				],
			});
			return result.rows;
		});
		return rows[0] ? fromIdentityProviderRow(rows[0]) : null;
	}

	async deleteIdentityProvider(tenantId: string, id: string): Promise<boolean> {
		const affected = await this.#exec(tenantId, {
			text: 'DELETE FROM auth_identity_providers WHERE tenant_id = $1 AND id = $2',
			parameters: [tenantId, id],
		});
		return affected > 0;
	}

	async revokeMembershipApiTokens(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `UPDATE auth_api_tokens SET revoked_at = $1, revoked_by = $2
			       WHERE tenant_id = $3 AND account_id = $4 AND revoked_at IS NULL`,
			parameters: [revokedAt, revokedBy, tenantId, accountId],
		});
	}

	async setMembershipStatus(
		accountId: string,
		tenantId: string,
		status: MembershipStatus,
	): Promise<boolean> {
		const affected = await this.#exec(tenantId, {
			text: `UPDATE auth_memberships SET status = $1
			       WHERE account_id = $2 AND tenant_id = $3`,
			parameters: [status, accountId, tenantId],
		});
		return affected > 0;
	}

	async findSignInFailure(
		normalizedEmail: string,
	): Promise<SignInFailureRecord | null> {
		const rows = await this.#query<{
			failures: number | bigint | string;
			locked_until: number | bigint | string | null;
		}>(IDENTITY_TENANT_CONTEXT, {
			text: `SELECT failures, locked_until FROM auth_sign_in_failures
			       WHERE email_normalized = $1`,
			parameters: [normalizedEmail],
		});
		const row = rows[0];
		return row
			? {
					failures: integer(row.failures),
					lockedUntil: optionalInteger(row.locked_until),
				}
			: null;
	}

	/* One row per address that failed recently; rows idle longer than the
	   retention window are dropped on the way in, so the table stays bounded
	   by recent activity instead of growing with every guessed address. The
	   read and the write share one transaction, so two attempts cannot both
	   count the same failure. */
	async recordSignInFailure(
		normalizedEmail: string,
		now: number,
		lockThreshold: number,
		lockMs: number,
		retentionMs: number,
	): Promise<SignInFailureRecord> {
		return this.#tx(IDENTITY_TENANT_CONTEXT, 'write', async (transaction) => {
			await transaction.execute({
				text: 'DELETE FROM auth_sign_in_failures WHERE updated_at < $1',
				parameters: [now - retentionMs],
			});
			const current = await transaction.query<{
				failures: number | bigint | string;
				locked_until: number | bigint | string | null;
			}>({
				text: `SELECT failures, locked_until FROM auth_sign_in_failures
				       WHERE email_normalized = $1`,
				parameters: [normalizedEmail],
			});
			const previous = current.rows[0];
			const failures = (previous ? integer(previous.failures) : 0) + 1;
			const lockedUntil =
				failures >= lockThreshold
					? now + lockMs
					: previous
						? optionalInteger(previous.locked_until)
						: null;
			await transaction.execute({
				text: `INSERT INTO auth_sign_in_failures
				       (email_normalized, failures, locked_until, updated_at)
				       VALUES ($1, $2, $3, $4)
				       ON CONFLICT (email_normalized) DO UPDATE SET
				         failures = excluded.failures,
				         locked_until = excluded.locked_until,
				         updated_at = excluded.updated_at`,
				parameters: [
					normalizedEmail,
					failures >= lockThreshold ? 0 : failures,
					lockedUntil,
					now,
				],
			});
			return { failures, lockedUntil };
		});
	}

	async clearSignInFailures(normalizedEmail: string): Promise<void> {
		await this.#exec(IDENTITY_TENANT_CONTEXT, {
			text: 'DELETE FROM auth_sign_in_failures WHERE email_normalized = $1',
			parameters: [normalizedEmail],
		});
	}

	async listRoles(tenantId: string): Promise<readonly TenantRole[]> {
		const rows = await this.#query<RoleRow>(tenantId, {
			text: `SELECT * FROM auth_roles WHERE tenant_id = $1
			       ORDER BY builtin DESC,
			         CASE key WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
			         lower(name), id`,
			parameters: [tenantId],
		});
		return rows.map(fromRoleRow);
	}

	async findRole(tenantId: string, id: string): Promise<TenantRole | null> {
		const rows = await this.#query<RoleRow>(tenantId, {
			text: 'SELECT * FROM auth_roles WHERE tenant_id = $1 AND id = $2',
			parameters: [tenantId, id],
		});
		return rows[0] ? fromRoleRow(rows[0]) : null;
	}

	async findRoleByKey(
		tenantId: string,
		key: string,
	): Promise<TenantRole | null> {
		const rows = await this.#query<RoleRow>(tenantId, {
			text: 'SELECT * FROM auth_roles WHERE tenant_id = $1 AND key = $2',
			parameters: [tenantId, key],
		});
		return rows[0] ? fromRoleRow(rows[0]) : null;
	}

	async createRole(record: CreateRoleRecord): Promise<TenantRole> {
		try {
			const rows = await this.#tx(
				record.tenantId,
				'write',
				async (transaction) => {
					const result = await transaction.query<RoleRow>({
						text: `INSERT INTO auth_roles
						       (id, tenant_id, key, name, description, scopes_json, builtin,
						        created_at, updated_at)
						       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
						       RETURNING *`,
						parameters: [
							record.id,
							record.tenantId,
							record.key,
							record.name,
							record.description,
							JSON.stringify(record.scopes),
							record.builtin ? 1 : 0,
							record.createdAt,
						],
					});
					return result.rows;
				},
			);
			return fromRoleRow(rows[0]!);
		} catch (error) {
			if (duplicate(error) === 'role-key') throw new DuplicateRoleKeyError();
			throw error;
		}
	}

	async updateRole(
		tenantId: string,
		id: string,
		patch: {
			readonly name: string;
			readonly description: string;
			readonly scopes: readonly string[];
		},
		updatedAt: number,
	): Promise<TenantRole | null> {
		const rows = await this.#tx(tenantId, 'write', async (transaction) => {
			const result = await transaction.query<RoleRow>({
				text: `UPDATE auth_roles SET name = $1, description = $2,
				       scopes_json = $3, updated_at = $4
				       WHERE tenant_id = $5 AND id = $6 RETURNING *`,
				parameters: [
					patch.name,
					patch.description,
					JSON.stringify(patch.scopes),
					updatedAt,
					tenantId,
					id,
				],
			});
			return result.rows;
		});
		return rows[0] ? fromRoleRow(rows[0]) : null;
	}

	async deleteRole(tenantId: string, id: string): Promise<boolean> {
		const affected = await this.#exec(tenantId, {
			text: `DELETE FROM auth_roles
			       WHERE tenant_id = $1 AND id = $2 AND builtin = 0`,
			parameters: [tenantId, id],
		});
		return affected > 0;
	}

	async countRoleMemberships(
		tenantId: string,
		roleId: string,
	): Promise<number> {
		const rows = await this.#query<CountRow>(tenantId, {
			text: `SELECT count(*) AS total FROM auth_memberships
			       WHERE tenant_id = $1 AND role_id = $2`,
			parameters: [tenantId, roleId],
		});
		return rows[0] ? integer(rows[0].total) : 0;
	}

	async appendAudit(record: AuditRecord): Promise<void> {
		await this.#exec(record.tenantId, {
			text: `INSERT INTO auth_audit
			       (tenant_id, actor_account_id, actor_label, actor_kind, actor_run_id,
			        action, subject_type, subject_id, metadata_json, occurred_at)
			       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			parameters: [
				record.tenantId,
				record.actorAccountId,
				record.actorLabel,
				record.actorKind,
				record.actorRunId,
				record.action,
				record.subjectType,
				record.subjectId,
				JSON.stringify(record.metadata),
				record.occurredAt,
			],
		});
	}

	async queryAudit(query: AuditQuery): Promise<readonly AuditActorEvent[]> {
		const parameters: DatabaseParameter[] = [query.tenantId];
		const conditions = ['tenant_id = $1'];
		const marker = (value: DatabaseParameter): string => {
			parameters.push(value);
			return `$${parameters.length}`;
		};
		if (query.action) conditions.push(`action = ${marker(query.action)}`);
		/* The window is inclusive and each end is independent, so a caller asks
		   for a date range instead of seeding the cursor at its ceiling and
		   watching every page for the floor. It composes with the filters and the
		   keyset rather than replacing any of them. */
		if (query.from !== undefined && query.from !== null) {
			conditions.push(`occurred_at >= ${marker(query.from)}`);
		}
		if (query.to !== undefined && query.to !== null) {
			conditions.push(`occurred_at <= ${marker(query.to)}`);
		}
		if (query.actor) {
			conditions.push(
				`(actor_account_id = ${marker(query.actor)} OR actor_label = ${marker(query.actor)})`,
			);
		}
		if (query.cursor) {
			const [occurredAt = NaN, id = NaN] = query.cursor.split(':').map(Number);
			if (Number.isSafeInteger(occurredAt) && Number.isSafeInteger(id)) {
				conditions.push(
					`(occurred_at < ${marker(occurredAt)} OR (occurred_at = ${marker(occurredAt)} AND id < ${marker(id)}))`,
				);
			}
		}
		const rows = await this.#query<AuditRow>(query.tenantId, {
			text: `SELECT * FROM auth_audit WHERE ${conditions.join(' AND ')}
			       ORDER BY occurred_at DESC, id DESC LIMIT ${marker(query.limit)}`,
			parameters,
		});
		return rows.map((row) => ({
			id: integer(row.id),
			tenantId: row.tenant_id,
			actorAccountId: row.actor_account_id,
			actorLabel: row.actor_label,
			actorKind: row.actor_kind,
			actorRunId: row.actor_run_id,
			action: row.action,
			subjectType: row.subject_type,
			subjectId: row.subject_id,
			metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
			occurredAt: integer(row.occurred_at),
		}));
	}

	async exportSessionsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly SessionExportRecord[]> {
		const rows = await this.#query<SessionExportRow>(tenantId, {
			text: `SELECT id, tenant_id, account_id, created_at, expires_at,
			       last_seen_at
			       FROM auth_sessions
			       WHERE tenant_id = $1 AND id > $2
			       ORDER BY id LIMIT $3`,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map((row) => ({
			id: row.id,
			tenantId: row.tenant_id,
			accountId: row.account_id,
			createdAt: integer(row.created_at),
			expiresAt: integer(row.expires_at),
			lastSeenAt: integer(row.last_seen_at),
		}));
	}

	async deleteSessionsExpiredBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `DELETE FROM auth_sessions WHERE token_hash IN (
			         SELECT token_hash FROM auth_sessions
			         WHERE tenant_id = $1 AND expires_at < $2
			         ORDER BY expires_at LIMIT $3)`,
			parameters: [tenantId, before, limit],
		});
	}

	async exportApiTokensPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly ApiTokenRecord[]> {
		const rows = await this.#query<ApiTokenRow>(tenantId, {
			text: `SELECT * FROM auth_api_tokens
			       WHERE tenant_id = $1 AND id > $2
			       ORDER BY id LIMIT $3`,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(fromApiTokenRow);
	}

	async deleteApiTokensRetiredBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `DELETE FROM auth_api_tokens WHERE id IN (
			         SELECT id FROM auth_api_tokens
			         WHERE tenant_id = $1
			           AND (revoked_at < $2 OR expires_at < $2)
			         ORDER BY id LIMIT $3)`,
			parameters: [tenantId, before, limit],
		});
	}

	async exportAuditEventsPage(
		tenantId: string,
		afterId: number,
		limit: number,
	): Promise<readonly AuditEvent[]> {
		const rows = await this.#query<AuditRow>(tenantId, {
			text: `SELECT * FROM auth_audit
			       WHERE tenant_id = $1 AND id > $2
			       ORDER BY id LIMIT $3`,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map((row) => ({
			id: integer(row.id),
			tenantId: row.tenant_id,
			actorAccountId: row.actor_account_id,
			actorLabel: row.actor_label,
			action: row.action,
			subjectType: row.subject_type,
			subjectId: row.subject_id,
			metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
			occurredAt: integer(row.occurred_at),
		}));
	}

	async deleteAuditEventsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `DELETE FROM auth_audit WHERE id IN (
			         SELECT id FROM auth_audit
			         WHERE tenant_id = $1 AND occurred_at < $2
			         ORDER BY occurred_at LIMIT $3)`,
			parameters: [tenantId, before, limit],
		});
	}

	async deleteMembershipSessionsOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `DELETE FROM auth_sessions WHERE token_hash IN (
			         SELECT token_hash FROM auth_sessions
			         WHERE tenant_id = $1 AND account_id = $2
			         ORDER BY token_hash LIMIT $3)`,
			parameters: [tenantId, accountId, limit],
		});
	}

	async deleteMembershipApiTokensOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.#exec(tenantId, {
			text: `DELETE FROM auth_api_tokens WHERE id IN (
			         SELECT id FROM auth_api_tokens
			         WHERE tenant_id = $1 AND account_id = $2
			         ORDER BY id LIMIT $3)`,
			parameters: [tenantId, accountId, limit],
		});
	}

	async loadSettings(
		tenantId: string,
		moduleId: string,
	): Promise<Readonly<Record<string, ModuleSettingValue>>> {
		const storage = settingsTenant(tenantId);
		const rows = await this.#query<{ key: string; value_json: string }>(
			storage,
			{
				text: `SELECT key, value_json FROM module_settings
				       WHERE tenant_id = $1 AND module_id = $2`,
				parameters: [storage, moduleId],
			},
		);
		const values: Record<string, ModuleSettingValue> = {};
		for (const row of rows) {
			const value = JSON.parse(row.value_json) as unknown;
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean'
			) {
				values[row.key] = value;
			}
		}
		return values;
	}

	async saveSetting(record: ModuleSettingRecord): Promise<void> {
		const storage = settingsTenant(record.tenantId);
		await this.#exec(storage, {
			text: `INSERT INTO module_settings
			       (tenant_id, module_id, key, value_json, updated_at, updated_by)
			       VALUES ($1, $2, $3, $4, $5, $6)
			       ON CONFLICT (tenant_id, module_id, key) DO UPDATE SET
			         value_json = excluded.value_json,
			         updated_at = excluded.updated_at,
			         updated_by = excluded.updated_by`,
			parameters: [
				storage,
				record.moduleId,
				record.key,
				JSON.stringify(record.value),
				record.updatedAt,
				record.updatedBy,
			],
		});
	}

	async clearSetting(
		tenantId: string,
		moduleId: string,
		key: string,
	): Promise<void> {
		const storage = settingsTenant(tenantId);
		await this.#exec(storage, {
			text: `DELETE FROM module_settings
			       WHERE tenant_id = $1 AND module_id = $2 AND key = $3`,
			parameters: [storage, moduleId, key],
		});
	}
}

function settingsTenant(tenantId: string): string {
	return tenantId === '' ? PLATFORM_SETTINGS_STORAGE_TENANT : tenantId;
}
