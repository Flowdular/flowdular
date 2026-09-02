import type { MigrationDatabase, ModuleMigration } from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const AUTH_MIGRATION_001 = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS auth_memberships (
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, tenant_id)
) STRICT;

CREATE TABLE IF NOT EXISTS auth_membership_scopes (
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  PRIMARY KEY (account_id, tenant_id, scope),
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES auth_memberships(account_id, tenant_id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS auth_sessions_account_idx
  ON auth_sessions(account_id, expires_at);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON auth_sessions(expires_at);
`;

export const AUTH_MIGRATION_002 = `INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope = 'system.modules.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role = 'member'
  );
`;

export const AUTH_MIGRATION_003 = `INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.execute' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.manage' FROM auth_memberships WHERE role = 'owner';
`;

export const AUTH_MIGRATION_004 = `DELETE FROM auth_membership_scopes
WHERE scope IN ('system.modules.read', 'system.specs.read', 'system.runs.read')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_005 = `INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.skills.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.read' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.test' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.skills.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope IN ('agents.providers.read', 'agents.providers.manage', 'agents.providers.test', 'agents.skills.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_006_TENANT_SLUG = `ALTER TABLE auth_tenants ADD COLUMN slug TEXT;
UPDATE auth_tenants SET slug = lower(id) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tenants_slug_idx ON auth_tenants(slug);
`;

export const AUTH_MIGRATION_007_SANDBOX_SCOPES = `INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.use' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.sessions.read' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.preview.data' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.modules.eject' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope IN ('sandbox.access.use', 'sandbox.access.manage', 'sandbox.sessions.read', 'sandbox.preview.data', 'sandbox.modules.eject')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_008_API_TOKENS = `CREATE TABLE IF NOT EXISTS auth_api_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES auth_memberships(account_id, tenant_id)
    ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS auth_api_tokens_tenant_idx
  ON auth_api_tokens (tenant_id, revoked_at, created_at DESC);

INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.tokens.read' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.tokens.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope IN ('auth.tokens.read', 'auth.tokens.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_009_MODULE_SETTINGS = `CREATE TABLE IF NOT EXISTS module_settings (
  tenant_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, module_id, key)
) STRICT;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.read' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope IN ('system.settings.read', 'system.settings.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_010_SIGN_IN_LOCKOUT = `CREATE TABLE IF NOT EXISTS auth_sign_in_failures (
  email_normalized TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_sign_in_failures_updated_idx
  ON auth_sign_in_failures (updated_at);
`;

export const AUTH_MIGRATION_011_SESSION_IDS_AND_PASSWORD_RESET = `-- Each ALTER runs only when pragma_table_info shows the column is missing.
ALTER TABLE auth_sessions ADD COLUMN id TEXT;
ALTER TABLE auth_accounts ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0;
UPDATE auth_sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_id_idx ON auth_sessions (id);
`;

export const AUTH_MIGRATION_012_ROLES = `CREATE TABLE IF NOT EXISTS auth_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, key)
) STRICT;
-- Guarded ALTER, see the repository constructor.
ALTER TABLE auth_memberships ADD COLUMN role_id TEXT;
-- Built-in owner and member rows are inserted per tenant by the repository from the static scope lists.
UPDATE auth_memberships SET role_id = tenant_id || ':' || role
WHERE role_id IS NULL AND role IN ('owner', 'member');
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.roles.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.roles.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope = 'auth.roles.manage'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_013_AUDIT = `CREATE TABLE IF NOT EXISTS auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor_account_id TEXT,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_audit_tenant_time_idx
  ON auth_audit (tenant_id, occurred_at DESC, id DESC);
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.audit.read' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope = 'auth.audit.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_014_AUDIT_ACTOR = `ALTER TABLE auth_audit ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (actor_kind IN ('user', 'agent'));
ALTER TABLE auth_audit ADD COLUMN actor_run_id TEXT
  CHECK (actor_run_id IS NULL OR length(actor_run_id) BETWEEN 1 AND 128);
`;

export const AUTH_MIGRATION_015_ACCOUNT_SECURITY = `CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_password_reset_tokens_account_expiry_idx
  ON auth_password_reset_tokens (account_id, expires_at, token_hash);

CREATE TABLE IF NOT EXISTS auth_tenant_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  role_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, email_normalized)
) STRICT;
CREATE INDEX IF NOT EXISTS auth_tenant_invitations_tenant_expiry_idx
  ON auth_tenant_invitations (tenant_id, expires_at, id);

CREATE TABLE IF NOT EXISTS auth_mfa_totp (
  account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS auth_mfa_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_mfa_recovery_codes_account_idx
  ON auth_mfa_recovery_codes (account_id, used_at, code_hash);

CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_expiry_idx
  ON auth_mfa_challenges (expires_at, token_hash);
`;

/* Scope backfills leave no schema behind, so adoption asks the database whether
   the grant each one carries already reached the memberships it targets. On a
   database with no memberships there is nothing to adopt and they simply run. */
function seeded(database: MigrationDatabase): boolean {
	return (
		database.prepare('SELECT 1 AS present FROM auth_memberships').get() !==
		undefined
	);
}

function membershipsMissing(
	database: MigrationDatabase,
	scope: string,
	role: 'any' | 'owner',
): boolean {
	return (
		database
			.prepare(
				`SELECT 1 AS present FROM auth_memberships m
				 WHERE ${role === 'owner' ? "m.role = 'owner' AND " : ''}NOT EXISTS (
				   SELECT 1 FROM auth_membership_scopes s
				   WHERE s.account_id = m.account_id
				     AND s.tenant_id = m.tenant_id
				     AND s.scope = ?
				 )`,
			)
			.get(scope) !== undefined
	);
}

function everyMembershipHasScope(
	scope: string,
): (database: MigrationDatabase) => boolean {
	return (database) =>
		seeded(database) && !membershipsMissing(database, scope, 'any');
}

function everyOwnerHasScope(
	scope: string,
): (database: MigrationDatabase) => boolean {
	return (database) =>
		seeded(database) && !membershipsMissing(database, scope, 'owner');
}

function noMemberHasScope(
	scopes: readonly string[],
): (database: MigrationDatabase) => boolean {
	return (database) =>
		seeded(database) &&
		database
			.prepare(
				`SELECT 1 AS present FROM auth_membership_scopes s
				 JOIN auth_memberships m
				   ON m.account_id = s.account_id AND m.tenant_id = s.tenant_id
				 WHERE m.role <> 'owner'
				   AND s.scope IN (${scopes.map(() => '?').join(', ')})`,
			)
			.get(...scopes) === undefined;
}

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_auth_core', statements: AUTH_MIGRATION_001 },
	{
		id: '0002_bundled_module_scopes',
		statements: AUTH_MIGRATION_002,
		adoptWhen: everyMembershipHasScope('users.members.read'),
	},
	{
		id: '0003_agent_core_scopes',
		statements: AUTH_MIGRATION_003,
		adoptWhen: everyMembershipHasScope('agents.definitions.read'),
	},
	{
		id: '0004_owner_only_development_scopes',
		statements: AUTH_MIGRATION_004,
		adoptWhen: noMemberHasScope([
			'system.modules.read',
			'system.specs.read',
			'system.runs.read',
		]),
	},
	{
		id: '0005_agent_provider_scopes',
		statements: AUTH_MIGRATION_005,
		adoptWhen: everyMembershipHasScope('agents.skills.read'),
	},
	{ id: '0006_tenant_slug', statements: AUTH_MIGRATION_006_TENANT_SLUG },
	{
		id: '0007_sandbox_scopes',
		statements: AUTH_MIGRATION_007_SANDBOX_SCOPES,
		adoptWhen: everyOwnerHasScope('sandbox.access.use'),
	},
	{ id: '0008_api_tokens', statements: AUTH_MIGRATION_008_API_TOKENS },
	{
		id: '0009_module_settings',
		statements: AUTH_MIGRATION_009_MODULE_SETTINGS,
	},
	{
		id: '0010_sign_in_lockout',
		statements: AUTH_MIGRATION_010_SIGN_IN_LOCKOUT,
	},
	{
		id: '0011_session_ids_and_password_reset',
		statements: AUTH_MIGRATION_011_SESSION_IDS_AND_PASSWORD_RESET,
	},
	{ id: '0012_roles', statements: AUTH_MIGRATION_012_ROLES },
	{ id: '0013_audit', statements: AUTH_MIGRATION_013_AUDIT },
	{ id: '0014_audit_actor', statements: AUTH_MIGRATION_014_AUDIT_ACTOR },
	{
		id: '0015_account_security',
		statements: AUTH_MIGRATION_015_ACCOUNT_SECURITY,
	},
];
