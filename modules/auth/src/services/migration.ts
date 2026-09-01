export const AUTH_MIGRATION_001 = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS auth_tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS auth_accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, email_normalized TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'disabled')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS auth_memberships (account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE, tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, tenant_id)) STRICT;
CREATE TABLE IF NOT EXISTS auth_membership_scopes (account_id TEXT NOT NULL, tenant_id TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY (account_id, tenant_id, scope), FOREIGN KEY (account_id, tenant_id) REFERENCES auth_memberships(account_id, tenant_id) ON DELETE CASCADE) STRICT;
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE, tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id, expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
`;

export const AUTH_MIGRATION_002 = `
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'users.members.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'parties.records.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'catalog.items.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'users.members.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'parties.records.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'catalog.items.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope = 'system.modules.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role = 'member'
  );
`;

export const AUTH_MIGRATION_003 = `
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.definitions.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.runs.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.runs.execute' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.definitions.manage' FROM auth_memberships WHERE role = 'owner';
`;

export const AUTH_MIGRATION_004 = `
DELETE FROM auth_membership_scopes
WHERE scope IN ('system.modules.read', 'system.specs.read', 'system.runs.read')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

/* Applied only when auth_tenants has no slug column yet; ALTER TABLE is not
   idempotent, so the repository guards it with a pragma_table_info check. */
export const AUTH_MIGRATION_006_TENANT_SLUG_COLUMN = `
ALTER TABLE auth_tenants ADD COLUMN slug TEXT;
`;

export const AUTH_MIGRATION_006_TENANT_SLUG_BACKFILL = `
UPDATE auth_tenants SET slug = lower(id) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tenants_slug_idx ON auth_tenants(slug);
`;

export const AUTH_MIGRATION_005 = `
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.skills.read' FROM auth_memberships;
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

export const AUTH_MIGRATION_007_SANDBOX_SCOPES = `
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.use' FROM auth_memberships WHERE role = 'owner';
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

export const AUTH_MIGRATION_008_API_TOKENS = `
CREATE TABLE IF NOT EXISTS auth_api_tokens (
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

export const AUTH_MIGRATION_009_MODULE_SETTINGS = `
CREATE TABLE IF NOT EXISTS module_settings (
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

export const AUTH_MIGRATION_010_SIGN_IN_LOCKOUT = `
CREATE TABLE IF NOT EXISTS auth_sign_in_failures (
  email_normalized TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_sign_in_failures_updated_idx
  ON auth_sign_in_failures (updated_at);
`;

/* Both ALTER statements are guarded by pragma_table_info in the repository. */
export const AUTH_MIGRATION_011_SESSION_ID_COLUMN = `
ALTER TABLE auth_sessions ADD COLUMN id TEXT;
`;

export const AUTH_MIGRATION_011_PASSWORD_RESET_COLUMN = `
ALTER TABLE auth_accounts ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0;
`;

export const AUTH_MIGRATION_011_SESSION_ID_BACKFILL = `
UPDATE auth_sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_id_idx ON auth_sessions (id);
`;

export const AUTH_MIGRATION_012_ROLES_TABLE = `
CREATE TABLE IF NOT EXISTS auth_roles (
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
`;

/* Guarded ALTER, see the repository constructor. */
export const AUTH_MIGRATION_012_ROLE_ID_COLUMN = `
ALTER TABLE auth_memberships ADD COLUMN role_id TEXT;
`;

export const AUTH_MIGRATION_012_ROLES_BACKFILL = `
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

export const AUTH_MIGRATION_013_AUDIT = `
CREATE TABLE IF NOT EXISTS auth_audit (
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
