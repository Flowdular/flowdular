import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	runModuleMigrations,
	type ActorKind,
	type ModuleSettingRecord,
	type ModuleSettingValue,
} from '@coreloom/kernel';
import { BUILTIN_ROLES } from '../acl/scopes.ts';
import type {
	ApiTokenRecord,
	AuditQuery,
	AuthPrincipal,
	AuthSession,
	AuthTenantAccess,
	SessionSummary,
	TenantRole,
} from '../domain/types.ts';
import { migrations } from './migration.ts';
import {
	DuplicateAccountError,
	DuplicateRoleKeyError,
	DuplicateTenantSlugError,
	type AccountCredential,
	type AuditActorEvent,
	type AuditRecord,
	type AuthRepository,
	type CreateAccountInTenantRecord,
	type CreateAccountRecord,
	type CreateRoleRecord,
	type CreateSessionRecord,
	type CreateApiTokenRecord,
	type CreateTenantMembershipRecord,
	type SignInFailureRecord,
	type TenantMember,
	type TenantSummary,
} from './repository.ts';

interface ApiTokenRow {
	id: string;
	tenant_id: string;
	account_id: string;
	label: string;
	prefix: string;
	token_hash: string;
	scopes_json: string;
	created_by: string;
	created_at: number;
	expires_at: number | null;
	last_used_at: number | null;
	revoked_at: number | null;
	revoked_by: string | null;
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
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		revokedBy: row.revoked_by,
	};
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
	password_change_required: number;
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
	password_change_required: number;
	scopes: string | null;
	created_at: number;
}

interface SessionRow extends AccountRow {
	session_id: string;
	csrf_token: string;
	expires_at: number;
	last_seen_at: number;
}

interface SessionSummaryRow {
	id: string;
	tenant_id: string;
	tenant_name: string;
	created_at: number;
	last_seen_at: number;
	expires_at: number;
}

interface RoleRow {
	id: string;
	tenant_id: string;
	key: string;
	name: string;
	description: string;
	scopes_json: string;
	builtin: number;
	created_at: number;
	updated_at: number;
}

function fromRoleRow(row: RoleRow): TenantRole {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.key,
		name: row.name,
		description: row.description,
		scopes: JSON.parse(row.scopes_json) as readonly string[],
		builtin: row.builtin === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

interface AuditRow {
	id: number;
	tenant_id: string;
	actor_account_id: string | null;
	actor_label: string;
	actor_kind: ActorKind;
	actor_run_id: string | null;
	action: string;
	subject_type: string;
	subject_id: string;
	metadata_json: string;
	occurred_at: number;
}

interface TenantRow {
	id: string;
	name: string;
	slug: string | null;
}

const ACCOUNT_COLUMNS = `a.id AS account_id, m.tenant_id, a.email, a.display_name,
	 a.password_hash, m.role, m.role_id, a.status, a.password_change_required`;

export function builtinRoleId(tenantId: string, key: string): string {
	return `${tenantId}:${key}`;
}

export class SqliteAuthRepository implements AuthRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
		this.#seedBuiltinRoles();
	}

	/* Every tenant carries the built-in roles as rows so custom roles and
	   built-in ones are listed, assigned, and audited the same way. */
	#seedBuiltinRoles(tenantId?: string): void {
		const insert = this.#database.prepare(
			`INSERT OR IGNORE INTO auth_roles
			 (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
			 SELECT id || ? , id, ?, ?, ?, ?, 1, created_at, created_at
			 FROM auth_tenants${tenantId === undefined ? '' : ' WHERE id = ?'}`,
		);
		for (const role of BUILTIN_ROLES) {
			const parameters = [
				`:${role.key}`,
				role.key,
				role.name,
				role.description,
				JSON.stringify(role.scopes),
			];
			if (tenantId !== undefined) parameters.push(tenantId);
			insert.run(...parameters);
		}
	}

	#scopes(accountId: string, tenantId: string): string[] {
		return (
			this.#database
				.prepare(
					'SELECT scope FROM auth_membership_scopes WHERE account_id = ? AND tenant_id = ? ORDER BY scope',
				)
				.all(accountId, tenantId) as unknown as ScopeRow[]
		).map((row) => row.scope);
	}

	#credential(row: AccountRow): AccountCredential {
		return {
			accountId: row.account_id,
			tenantId: row.tenant_id,
			email: row.email,
			displayName: row.display_name,
			passwordHash: row.password_hash,
			role: row.role,
			roleId: row.role_id,
			status: row.status,
			passwordChangeRequired: row.password_change_required === 1,
			scopes: this.#scopes(row.account_id, row.tenant_id),
		};
	}

	#insertScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): void {
		const insert = this.#database.prepare(
			'INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) VALUES (?, ?, ?)',
		);
		for (const scope of scopes) insert.run(accountId, tenantId, scope);
	}

	#tenant(row: TenantRow): TenantSummary {
		return { tenantId: row.id, name: row.name, slug: row.slug ?? row.id };
	}

	listTenantAccess(accountId: string): readonly AuthTenantAccess[] {
		return (
			this.#database
				.prepare(
					`SELECT t.id AS tenant_id, t.name, t.slug, m.role
					 FROM auth_memberships m
					 JOIN auth_tenants t ON t.id = m.tenant_id
					 WHERE m.account_id = ?
					 ORDER BY m.created_at, t.id`,
				)
				.all(accountId) as unknown as TenantAccessRow[]
		).map((row) => ({
			tenantId: row.tenant_id,
			name: row.name,
			slug: row.slug,
			role: row.role,
		}));
	}

	listTenantMembers(tenantId: string): readonly TenantMember[] {
		return (
			this.#database
				.prepare(
					`SELECT a.id AS account_id, a.email, a.display_name, m.role, m.role_id,
					 a.status, a.password_change_required, m.created_at,
					 (SELECT group_concat(s.scope, ' ') FROM (
					    SELECT scope FROM auth_membership_scopes
					    WHERE account_id = m.account_id AND tenant_id = m.tenant_id ORDER BY scope
					  ) s) AS scopes
					 FROM auth_memberships m
					 JOIN auth_accounts a ON a.id = m.account_id
					 WHERE m.tenant_id = ?
					 ORDER BY lower(a.display_name), a.id`,
				)
				.all(tenantId) as unknown as TenantMemberRow[]
		).map((row) => ({
			accountId: row.account_id,
			email: row.email,
			displayName: row.display_name,
			role: row.role,
			roleId: row.role_id,
			status: row.status,
			scopes: row.scopes ? row.scopes.split(' ') : [],
			passwordChangeRequired: row.password_change_required === 1,
			createdAt: row.created_at,
		}));
	}

	listTenantScopes(tenantId: string): readonly string[] {
		return (
			this.#database
				.prepare(
					'SELECT DISTINCT scope FROM auth_membership_scopes WHERE tenant_id = ? ORDER BY scope',
				)
				.all(tenantId) as unknown as ScopeRow[]
		).map((row) => row.scope);
	}

	isTenantSlugTaken(slug: string): boolean {
		return (
			this.#database
				.prepare('SELECT 1 AS present FROM auth_tenants WHERE slug = ?')
				.get(slug) !== undefined
		);
	}

	listTenants(): readonly TenantSummary[] {
		return (
			this.#database
				.prepare('SELECT id, name, slug FROM auth_tenants ORDER BY name, id')
				.all() as unknown as TenantRow[]
		).map((row) => this.#tenant(row));
	}

	renameTenant(tenantId: string, name: string): TenantSummary | null {
		this.#database
			.prepare('UPDATE auth_tenants SET name = ? WHERE id = ?')
			.run(name, tenantId);
		return this.findTenant(tenantId);
	}

	listOwnerMemberships(): readonly {
		readonly accountId: string;
		readonly tenantId: string;
	}[] {
		return (
			this.#database
				.prepare(
					"SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'owner' ORDER BY tenant_id, account_id",
				)
				.all() as unknown as { account_id: string; tenant_id: string }[]
		).map((row) => ({ accountId: row.account_id, tenantId: row.tenant_id }));
	}

	findAccountCredentialById(accountId: string): AccountCredential | null {
		const row = this.#database
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS}
				 FROM auth_accounts a
				 JOIN auth_memberships m ON m.account_id = a.id
				 WHERE a.id = ?
				 ORDER BY m.created_at LIMIT 1`,
			)
			.get(accountId) as unknown as AccountRow | undefined;
		return row ? this.#credential(row) : null;
	}

	updatePasswordHash(
		accountId: string,
		passwordHash: string,
		changeRequired: boolean,
	): void {
		this.#database
			.prepare(
				'UPDATE auth_accounts SET password_hash = ?, password_change_required = ? WHERE id = ?',
			)
			.run(passwordHash, changeRequired ? 1 : 0, accountId);
	}

	updateAccountDisplayName(accountId: string, displayName: string): void {
		this.#database
			.prepare('UPDATE auth_accounts SET display_name = ? WHERE id = ?')
			.run(displayName, accountId);
	}

	updateAccountStatus(accountId: string, status: 'active' | 'disabled'): void {
		this.#database
			.prepare('UPDATE auth_accounts SET status = ? WHERE id = ?')
			.run(status, accountId);
	}

	/* A credential change invalidates every other session of that account. */
	deleteAccountSessions(
		accountId: string,
		exceptTokenHash: string | null,
	): void {
		if (exceptTokenHash) {
			this.#database
				.prepare(
					'DELETE FROM auth_sessions WHERE account_id = ? AND token_hash <> ?',
				)
				.run(accountId, exceptTokenHash);
			return;
		}
		this.#database
			.prepare('DELETE FROM auth_sessions WHERE account_id = ?')
			.run(accountId);
	}

	deleteMembershipSessions(accountId: string, tenantId: string): void {
		this.#database
			.prepare(
				'DELETE FROM auth_sessions WHERE account_id = ? AND tenant_id = ?',
			)
			.run(accountId, tenantId);
	}

	deleteMembership(accountId: string, tenantId: string): boolean {
		this.deleteMembershipSessions(accountId, tenantId);
		return (
			Number(
				this.#database
					.prepare(
						'DELETE FROM auth_memberships WHERE account_id = ? AND tenant_id = ?',
					)
					.run(accountId, tenantId).changes,
			) > 0
		);
	}

	countMemberships(accountId: string): number {
		return Number(
			(
				this.#database
					.prepare(
						'SELECT count(*) AS total FROM auth_memberships WHERE account_id = ?',
					)
					.get(accountId) as { total: number }
			).total,
		);
	}

	deleteAccount(accountId: string): void {
		this.#database
			.prepare('DELETE FROM auth_accounts WHERE id = ?')
			.run(accountId);
	}

	countActiveOwners(tenantId: string): number {
		return Number(
			(
				this.#database
					.prepare(
						`SELECT count(*) AS total FROM auth_memberships m
						 JOIN auth_accounts a ON a.id = m.account_id
						 WHERE m.tenant_id = ? AND m.role = 'owner' AND a.status = 'active'`,
					)
					.get(tenantId) as { total: number }
			).total,
		);
	}

	findTenant(reference: string): TenantSummary | null {
		const row = this.#database
			.prepare(
				'SELECT id, name, slug FROM auth_tenants WHERE id = ? OR slug = ? LIMIT 1',
			)
			.get(reference, reference) as unknown as TenantRow | undefined;
		return row ? this.#tenant(row) : null;
	}

	findAccountByEmail(normalizedEmail: string): AccountCredential | null {
		const row = this.#database
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS}
				 FROM auth_accounts a
				 JOIN auth_memberships m ON m.account_id = a.id
				 WHERE a.email_normalized = ?
				 ORDER BY m.created_at LIMIT 1`,
			)
			.get(normalizedEmail) as unknown as AccountRow | undefined;
		return row ? this.#credential(row) : null;
	}

	findAccountMembership(
		accountId: string,
		tenantId: string,
	): AccountCredential | null {
		const row = this.#database
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS}
				 FROM auth_accounts a
				 JOIN auth_memberships m ON m.account_id = a.id
				 WHERE a.id = ? AND m.tenant_id = ?`,
			)
			.get(accountId, tenantId) as unknown as AccountRow | undefined;
		return row ? this.#credential(row) : null;
	}

	#insertTenant(
		tenantId: string,
		name: string,
		slug: string,
		createdAt: number,
	): void {
		this.#database
			.prepare(
				'INSERT INTO auth_tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
			)
			.run(tenantId, name, slug, createdAt);
		this.#seedBuiltinRoles(tenantId);
	}

	#insertMembership(
		accountId: string,
		tenantId: string,
		role: string,
		roleId: string | null,
		createdAt: number,
	): void {
		this.#database
			.prepare(
				'INSERT INTO auth_memberships (account_id, tenant_id, role, role_id, created_at) VALUES (?, ?, ?, ?, ?)',
			)
			.run(accountId, tenantId, role, roleId, createdAt);
	}

	createAccountWithTenant(record: CreateAccountRecord): AccountCredential {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#insertTenant(
				record.tenantId,
				record.organizationName,
				record.organizationSlug,
				record.createdAt,
			);
			this.#database
				.prepare(
					`INSERT INTO auth_accounts
					 (id, email, email_normalized, password_hash, display_name, status, created_at)
					 VALUES (?, ?, ?, ?, ?, 'active', ?)`,
				)
				.run(
					record.accountId,
					record.email,
					record.normalizedEmail,
					record.passwordHash,
					record.displayName,
					record.createdAt,
				);
			this.#insertMembership(
				record.accountId,
				record.tenantId,
				record.role,
				builtinRoleId(record.tenantId, record.role),
				record.createdAt,
			);
			this.#insertScopes(record.accountId, record.tenantId, record.scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('auth_accounts.email_normalized')) {
				throw new DuplicateAccountError();
			}
			if (String(error).includes('auth_tenants.slug')) {
				throw new DuplicateTenantSlugError();
			}
			throw error;
		}

		return this.findAccountMembership(record.accountId, record.tenantId)!;
	}

	createAccountInTenant(
		record: CreateAccountInTenantRecord,
	): AccountCredential {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					`INSERT INTO auth_accounts
					 (id, email, email_normalized, password_hash, display_name, status, created_at)
					 VALUES (?, ?, ?, ?, ?, 'active', ?)`,
				)
				.run(
					record.accountId,
					record.email,
					record.normalizedEmail,
					record.passwordHash,
					record.displayName,
					record.createdAt,
				);
			this.#insertMembership(
				record.accountId,
				record.tenantId,
				record.role,
				record.roleId,
				record.createdAt,
			);
			this.#insertScopes(record.accountId, record.tenantId, record.scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('auth_accounts.email_normalized')) {
				throw new DuplicateAccountError();
			}
			throw error;
		}
		return this.findAccountMembership(record.accountId, record.tenantId)!;
	}

	createTenantMembership(
		record: CreateTenantMembershipRecord,
	): AccountCredential {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#insertTenant(
				record.tenantId,
				record.organizationName,
				record.organizationSlug,
				record.createdAt,
			);
			this.#insertMembership(
				record.accountId,
				record.tenantId,
				record.role,
				builtinRoleId(record.tenantId, record.role),
				record.createdAt,
			);
			this.#insertScopes(record.accountId, record.tenantId, record.scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('auth_tenants.slug')) {
				throw new DuplicateTenantSlugError();
			}
			throw error;
		}
		return this.findAccountMembership(record.accountId, record.tenantId)!;
	}

	createMembershipInTenant(record: {
		readonly accountId: string;
		readonly tenantId: string;
		readonly role: string;
		readonly roleId: string | null;
		readonly scopes: readonly string[];
		readonly createdAt: number;
	}): AccountCredential {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#insertMembership(
				record.accountId,
				record.tenantId,
				record.role,
				record.roleId,
				record.createdAt,
			);
			this.#insertScopes(record.accountId, record.tenantId, record.scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
		return this.findAccountMembership(record.accountId, record.tenantId)!;
	}

	createApiToken(record: CreateApiTokenRecord): ApiTokenRecord {
		this.#database
			.prepare(
				`INSERT INTO auth_api_tokens
				 (id, tenant_id, account_id, label, prefix, token_hash, scopes_json,
				  created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
			)
			.run(
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
			);
		return this.#apiToken('id', record.id)!;
	}

	listApiTokens(tenantId: string): readonly ApiTokenRecord[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM auth_api_tokens WHERE tenant_id = ?
					 ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
				)
				.all(tenantId) as unknown as ApiTokenRow[]
		).map(fromApiTokenRow);
	}

	findApiTokenByHash(tokenHash: string): ApiTokenRecord | null {
		return this.#apiToken('token_hash', tokenHash);
	}

	touchApiToken(id: string, usedAt: number): void {
		this.#database
			.prepare('UPDATE auth_api_tokens SET last_used_at = ? WHERE id = ?')
			.run(usedAt, id);
	}

	revokeApiToken(
		tenantId: string,
		id: string,
		revokedAt: number,
		revokedBy: string,
	): ApiTokenRecord | null {
		this.#database
			.prepare(
				`UPDATE auth_api_tokens SET revoked_at = ?, revoked_by = ?
				 WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
			)
			.run(revokedAt, revokedBy, tenantId, id);
		const record = this.#apiToken('id', id);
		return record && record.tenantId === tenantId ? record : null;
	}

	#apiToken(column: 'id' | 'token_hash', value: string): ApiTokenRecord | null {
		const row = this.#database
			.prepare(`SELECT * FROM auth_api_tokens WHERE ${column} = ?`)
			.get(value) as unknown as ApiTokenRow | undefined;
		return row ? fromApiTokenRow(row) : null;
	}

	insertMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): void {
		this.#insertScopes(accountId, tenantId, scopes);
	}

	replaceMembershipScopes(
		accountId: string,
		tenantId: string,
		scopes: readonly string[],
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					'DELETE FROM auth_membership_scopes WHERE account_id = ? AND tenant_id = ?',
				)
				.run(accountId, tenantId);
			this.#insertScopes(accountId, tenantId, scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	updateMembershipRole(
		accountId: string,
		tenantId: string,
		role: string,
		roleId: string | null,
		scopes: readonly string[],
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					'UPDATE auth_memberships SET role = ?, role_id = ? WHERE account_id = ? AND tenant_id = ?',
				)
				.run(role, roleId, accountId, tenantId);
			this.#database
				.prepare(
					'DELETE FROM auth_membership_scopes WHERE account_id = ? AND tenant_id = ?',
				)
				.run(accountId, tenantId);
			this.#insertScopes(accountId, tenantId, scopes);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	createSession(record: CreateSessionRecord): void {
		this.#database
			.prepare(
				`INSERT INTO auth_sessions
				 (id, token_hash, account_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.id,
				record.tokenHash,
				record.accountId,
				record.tenantId,
				record.csrfToken,
				record.createdAt,
				record.expiresAt,
				record.createdAt,
			);
	}

	findSession(
		tokenHash: string,
		now: number,
		idleMs: number,
		touchIntervalMs: number,
	): AuthSession | null {
		const row = this.#database
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS}, s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at
				 FROM auth_sessions s
				 JOIN auth_accounts a ON a.id = s.account_id
				 JOIN auth_memberships m ON m.account_id = s.account_id AND m.tenant_id = s.tenant_id
				 WHERE s.token_hash = ? AND s.expires_at > ? AND a.status = 'active'`,
			)
			.get(tokenHash, now) as unknown as SessionRow | undefined;
		if (!row) return null;
		if (now - row.last_seen_at > idleMs) {
			this.deleteSession(tokenHash);
			return null;
		}
		if (now - row.last_seen_at >= touchIntervalMs) {
			this.#database
				.prepare(
					'UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?',
				)
				.run(now, tokenHash);
		}
		const principal: AuthPrincipal = {
			accountId: row.account_id,
			tenantId: row.tenant_id,
			email: row.email,
			displayName: row.display_name,
			role: row.role,
			scopes: this.#scopes(row.account_id, row.tenant_id),
			tenants: this.listTenantAccess(row.account_id),
		};
		return {
			principal,
			csrfToken: row.csrf_token,
			expiresAt: row.expires_at,
			sessionId: row.session_id,
			passwordChangeRequired: row.password_change_required === 1,
		};
	}

	listAccountSessions(
		accountId: string,
		now: number,
	): readonly SessionSummary[] {
		return (
			this.#database
				.prepare(
					`SELECT s.id, s.tenant_id, t.name AS tenant_name, s.created_at, s.last_seen_at, s.expires_at
					 FROM auth_sessions s
					 JOIN auth_tenants t ON t.id = s.tenant_id
					 WHERE s.account_id = ? AND s.expires_at > ?
					 ORDER BY s.last_seen_at DESC, s.id`,
				)
				.all(accountId, now) as unknown as SessionSummaryRow[]
		).map((row) => ({
			id: row.id,
			tenantId: row.tenant_id,
			tenantName: row.tenant_name,
			createdAt: row.created_at,
			lastSeenAt: row.last_seen_at,
			expiresAt: row.expires_at,
		}));
	}

	deleteSession(tokenHash: string): void {
		this.#database
			.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
			.run(tokenHash);
	}

	deleteSessionById(accountId: string, id: string): boolean {
		return (
			Number(
				this.#database
					.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND id = ?')
					.run(accountId, id).changes,
			) > 0
		);
	}

	deleteExpiredSessions(now: number): number {
		return Number(
			this.#database
				.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?')
				.run(now).changes,
		);
	}

	createPasswordResetToken(
		record: import('./repository.ts').PasswordResetTokenRecord,
	): void {
		this.#database
			.prepare(
				'DELETE FROM auth_password_reset_tokens WHERE account_id = ? OR expires_at <= ?',
			)
			.run(record.accountId, record.createdAt);
		this.#database
			.prepare(
				`INSERT INTO auth_password_reset_tokens (token_hash, account_id, expires_at, used_at, created_at)
				 VALUES (?, ?, ?, NULL, ?)`,
			)
			.run(
				record.tokenHash,
				record.accountId,
				record.expiresAt,
				record.createdAt,
			);
	}

	consumePasswordResetToken(tokenHash: string, now: number): string | null {
		const row = this.#database
			.prepare(
				`SELECT account_id FROM auth_password_reset_tokens
				 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
			)
			.get(tokenHash, now) as { account_id: string } | undefined;
		if (!row) return null;
		const changed = this.#database
			.prepare(
				`UPDATE auth_password_reset_tokens SET used_at = ?
				 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
			)
			.run(now, tokenHash, now).changes;
		return Number(changed) === 1 ? row.account_id : null;
	}

	createTenantInvitation(
		record: import('./repository.ts').TenantInvitationRecord,
	): void {
		this.#database
			.prepare(
				`DELETE FROM auth_tenant_invitations
				 WHERE tenant_id = ? AND email_normalized = ?`,
			)
			.run(record.tenantId, record.normalizedEmail);
		this.#database
			.prepare(
				`INSERT INTO auth_tenant_invitations
				 (id, tenant_id, email, email_normalized, role_key, token_hash, expires_at, accepted_at, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
			.run(
				record.id,
				record.tenantId,
				record.email,
				record.normalizedEmail,
				record.roleKey,
				record.tokenHash,
				record.expiresAt,
				record.createdBy,
				record.createdAt,
			);
	}

	consumeTenantInvitation(
		tokenHash: string,
		now: number,
	): {
		readonly tenantId: string;
		readonly email: string;
		readonly normalizedEmail: string;
		readonly roleKey: string;
	} | null {
		const row = this.#database
			.prepare(
				`SELECT tenant_id, email, email_normalized, role_key FROM auth_tenant_invitations
				 WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
			)
			.get(tokenHash, now) as
			| {
					tenant_id: string;
					email: string;
					email_normalized: string;
					role_key: string;
			  }
			| undefined;
		if (!row) return null;
		const changed = this.#database
			.prepare(
				`UPDATE auth_tenant_invitations SET accepted_at = ?
				 WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
			)
			.run(now, tokenHash, now).changes;
		return Number(changed) === 1
			? {
					tenantId: row.tenant_id,
					email: row.email,
					normalizedEmail: row.email_normalized,
					roleKey: row.role_key,
				}
			: null;
	}

	upsertMfaTotp(
		accountId: string,
		secretCiphertext: string,
		createdAt: number,
	): void {
		this.#database
			.prepare(
				`INSERT INTO auth_mfa_totp (account_id, secret_ciphertext, confirmed_at, created_at)
				 VALUES (?, ?, NULL, ?)
				 ON CONFLICT(account_id) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
				 confirmed_at = NULL, created_at = excluded.created_at`,
			)
			.run(accountId, secretCiphertext, createdAt);
	}

	findMfaTotp(accountId: string): {
		readonly secretCiphertext: string;
		readonly confirmedAt: number | null;
	} | null {
		const row = this.#database
			.prepare(
				'SELECT secret_ciphertext, confirmed_at FROM auth_mfa_totp WHERE account_id = ?',
			)
			.get(accountId) as
			| { secret_ciphertext: string; confirmed_at: number | null }
			| undefined;
		return row
			? {
					secretCiphertext: row.secret_ciphertext,
					confirmedAt: row.confirmed_at,
				}
			: null;
	}

	confirmMfaTotp(accountId: string, confirmedAt: number): void {
		this.#database
			.prepare('UPDATE auth_mfa_totp SET confirmed_at = ? WHERE account_id = ?')
			.run(confirmedAt, accountId);
	}

	replaceMfaRecoveryCodes(
		accountId: string,
		codeHashes: readonly string[],
		createdAt: number,
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare('DELETE FROM auth_mfa_recovery_codes WHERE account_id = ?')
				.run(accountId);
			const insert = this.#database.prepare(
				'INSERT INTO auth_mfa_recovery_codes (code_hash, account_id, used_at, created_at) VALUES (?, ?, NULL, ?)',
			);
			for (const codeHash of codeHashes)
				insert.run(codeHash, accountId, createdAt);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	consumeMfaRecoveryCode(accountId: string, codeHash: string): boolean {
		return (
			Number(
				this.#database
					.prepare(
						`UPDATE auth_mfa_recovery_codes SET used_at = unixepoch() * 1000
					 WHERE account_id = ? AND code_hash = ? AND used_at IS NULL`,
					)
					.run(accountId, codeHash).changes,
			) === 1
		);
	}

	createMfaChallenge(
		record: import('./repository.ts').MfaChallengeRecord,
	): void {
		this.#database
			.prepare('DELETE FROM auth_mfa_challenges WHERE expires_at <= ?')
			.run(record.createdAt);
		this.#database
			.prepare(
				`INSERT INTO auth_mfa_challenges (token_hash, account_id, tenant_id, expires_at, used_at, created_at)
				 VALUES (?, ?, ?, ?, NULL, ?)`,
			)
			.run(
				record.tokenHash,
				record.accountId,
				record.tenantId,
				record.expiresAt,
				record.createdAt,
			);
	}

	consumeMfaChallenge(
		tokenHash: string,
		now: number,
	): { readonly accountId: string; readonly tenantId: string } | null {
		const row = this.#database
			.prepare(
				`SELECT account_id, tenant_id FROM auth_mfa_challenges
				 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
			)
			.get(tokenHash, now) as
			| { account_id: string; tenant_id: string }
			| undefined;
		if (!row) return null;
		const changed = this.#database
			.prepare(
				`UPDATE auth_mfa_challenges SET used_at = ?
				 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
			)
			.run(now, tokenHash, now).changes;
		return Number(changed) === 1
			? { accountId: row.account_id, tenantId: row.tenant_id }
			: null;
	}

	findSignInFailure(normalizedEmail: string): SignInFailureRecord | null {
		const row = this.#database
			.prepare(
				'SELECT failures, locked_until FROM auth_sign_in_failures WHERE email_normalized = ?',
			)
			.get(normalizedEmail) as unknown as
			| { failures: number; locked_until: number | null }
			| undefined;
		return row
			? { failures: row.failures, lockedUntil: row.locked_until }
			: null;
	}

	/* One row per address that failed recently; rows idle longer than the
	   retention window are dropped on the way in, so the table stays bounded
	   by recent activity instead of growing with every guessed address. */
	recordSignInFailure(
		normalizedEmail: string,
		now: number,
		lockThreshold: number,
		lockMs: number,
		retentionMs: number,
	): SignInFailureRecord {
		this.#database
			.prepare('DELETE FROM auth_sign_in_failures WHERE updated_at < ?')
			.run(now - retentionMs);
		const current = this.findSignInFailure(normalizedEmail);
		const failures = (current?.failures ?? 0) + 1;
		const lockedUntil =
			failures >= lockThreshold ? now + lockMs : (current?.lockedUntil ?? null);
		this.#database
			.prepare(
				`INSERT INTO auth_sign_in_failures (email_normalized, failures, locked_until, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT (email_normalized) DO UPDATE SET
				   failures = excluded.failures,
				   locked_until = excluded.locked_until,
				   updated_at = excluded.updated_at`,
			)
			.run(
				normalizedEmail,
				failures >= lockThreshold ? 0 : failures,
				lockedUntil,
				now,
			);
		return { failures, lockedUntil };
	}

	clearSignInFailures(normalizedEmail: string): void {
		this.#database
			.prepare('DELETE FROM auth_sign_in_failures WHERE email_normalized = ?')
			.run(normalizedEmail);
	}

	listRoles(tenantId: string): readonly TenantRole[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM auth_roles WHERE tenant_id = ?
					 ORDER BY builtin DESC, CASE key WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, lower(name), id`,
				)
				.all(tenantId) as unknown as RoleRow[]
		).map(fromRoleRow);
	}

	findRole(tenantId: string, id: string): TenantRole | null {
		const row = this.#database
			.prepare('SELECT * FROM auth_roles WHERE tenant_id = ? AND id = ?')
			.get(tenantId, id) as unknown as RoleRow | undefined;
		return row ? fromRoleRow(row) : null;
	}

	findRoleByKey(tenantId: string, key: string): TenantRole | null {
		const row = this.#database
			.prepare('SELECT * FROM auth_roles WHERE tenant_id = ? AND key = ?')
			.get(tenantId, key) as unknown as RoleRow | undefined;
		return row ? fromRoleRow(row) : null;
	}

	createRole(record: CreateRoleRecord): TenantRole {
		try {
			this.#database
				.prepare(
					`INSERT INTO auth_roles
					 (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.id,
					record.tenantId,
					record.key,
					record.name,
					record.description,
					JSON.stringify(record.scopes),
					record.builtin ? 1 : 0,
					record.createdAt,
					record.createdAt,
				);
		} catch (error) {
			if (String(error).includes('auth_roles.tenant_id, auth_roles.key')) {
				throw new DuplicateRoleKeyError();
			}
			throw error;
		}
		return this.findRole(record.tenantId, record.id)!;
	}

	updateRole(
		tenantId: string,
		id: string,
		patch: {
			readonly name: string;
			readonly description: string;
			readonly scopes: readonly string[];
		},
		updatedAt: number,
	): TenantRole | null {
		this.#database
			.prepare(
				`UPDATE auth_roles SET name = ?, description = ?, scopes_json = ?, updated_at = ?
				 WHERE tenant_id = ? AND id = ?`,
			)
			.run(
				patch.name,
				patch.description,
				JSON.stringify(patch.scopes),
				updatedAt,
				tenantId,
				id,
			);
		return this.findRole(tenantId, id);
	}

	deleteRole(tenantId: string, id: string): boolean {
		return (
			Number(
				this.#database
					.prepare(
						'DELETE FROM auth_roles WHERE tenant_id = ? AND id = ? AND builtin = 0',
					)
					.run(tenantId, id).changes,
			) > 0
		);
	}

	countRoleMemberships(tenantId: string, roleId: string): number {
		return Number(
			(
				this.#database
					.prepare(
						'SELECT count(*) AS total FROM auth_memberships WHERE tenant_id = ? AND role_id = ?',
					)
					.get(tenantId, roleId) as { total: number }
			).total,
		);
	}

	appendAudit(record: AuditRecord): void {
		this.#database
			.prepare(
				`INSERT INTO auth_audit
				 (tenant_id, actor_account_id, actor_label, actor_kind, actor_run_id, action, subject_type, subject_id, metadata_json, occurred_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
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
			);
	}

	queryAudit(query: AuditQuery): readonly AuditActorEvent[] {
		const conditions = ['tenant_id = ?'];
		const parameters: (string | number)[] = [query.tenantId];
		if (query.action) {
			conditions.push('action = ?');
			parameters.push(query.action);
		}
		if (query.actor) {
			conditions.push('(actor_account_id = ? OR actor_label = ?)');
			parameters.push(query.actor, query.actor);
		}
		if (query.cursor) {
			const [occurredAt = NaN, id = NaN] = query.cursor.split(':').map(Number);
			if (Number.isSafeInteger(occurredAt) && Number.isSafeInteger(id)) {
				conditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
				parameters.push(occurredAt, occurredAt, id);
			}
		}
		parameters.push(query.limit);
		return (
			this.#database
				.prepare(
					`SELECT * FROM auth_audit WHERE ${conditions.join(' AND ')}
					 ORDER BY occurred_at DESC, id DESC LIMIT ?`,
				)
				.all(...parameters) as unknown as AuditRow[]
		).map((row) => ({
			id: row.id,
			tenantId: row.tenant_id,
			actorAccountId: row.actor_account_id,
			actorLabel: row.actor_label,
			actorKind: row.actor_kind,
			actorRunId: row.actor_run_id,
			action: row.action,
			subjectType: row.subject_type,
			subjectId: row.subject_id,
			metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
			occurredAt: row.occurred_at,
		}));
	}

	load(
		tenantId: string,
		moduleId: string,
	): Readonly<Record<string, ModuleSettingValue>> {
		const values: Record<string, ModuleSettingValue> = {};
		for (const row of this.#database
			.prepare(
				'SELECT key, value_json FROM module_settings WHERE tenant_id = ? AND module_id = ?',
			)
			.all(tenantId, moduleId) as unknown as {
			key: string;
			value_json: string;
		}[]) {
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

	save(record: ModuleSettingRecord): void {
		this.#database
			.prepare(
				`INSERT INTO module_settings (tenant_id, module_id, key, value_json, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (tenant_id, module_id, key) DO UPDATE SET
				   value_json = excluded.value_json,
				   updated_at = excluded.updated_at,
				   updated_by = excluded.updated_by`,
			)
			.run(
				record.tenantId,
				record.moduleId,
				record.key,
				JSON.stringify(record.value),
				record.updatedAt,
				record.updatedBy,
			);
	}

	clear(tenantId: string, moduleId: string, key: string): void {
		this.#database
			.prepare(
				'DELETE FROM module_settings WHERE tenant_id = ? AND module_id = ? AND key = ?',
			)
			.run(tenantId, moduleId, key);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}
