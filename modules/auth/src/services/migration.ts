import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const AUTH_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS auth_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- An account is one global identity that may hold memberships in several
-- workspaces, and sign-in reaches it before any workspace is known. It carries
-- no tenant column, so it carries no tenant policy either; the workspace
-- boundary is expressed by the membership tables below.
CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_memberships (
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS auth_membership_scopes (
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  PRIMARY KEY (account_id, tenant_id, scope),
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES auth_memberships(account_id, tenant_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_account_idx
  ON auth_sessions(account_id, expires_at);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON auth_sessions(expires_at);

-- A workspace row is its own tenant, so the policy binds the primary key and a
-- runtime connection reads or renames only the workspace it entered.
ALTER TABLE auth_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_tenants_tenant_policy ON auth_tenants
  USING (id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (id = current_setting('coreloom.tenant_id', true));

ALTER TABLE auth_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_memberships_tenant_policy ON auth_memberships
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE auth_membership_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_membership_scopes_tenant_policy ON auth_membership_scopes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_tenant_policy ON auth_sessions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A session cookie, a workspace list and a sign-in all arrive with a key that
-- names no workspace, so auth.core resolves the owning tenant on the read-only
-- background role and then does the work under that tenant. The key is the
-- whole predicate such a read can have, so these policies narrow by column
-- grant: everything outside the grant stays unreadable on that connection,
-- inside a WHERE clause too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY auth_tenants_background_policy ON auth_tenants
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON auth_tenants FROM coreloom_background;
GRANT SELECT (id, name) ON auth_tenants TO coreloom_background;
CREATE POLICY auth_memberships_background_policy ON auth_memberships
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON auth_memberships FROM coreloom_background;
GRANT SELECT (account_id, tenant_id, role, created_at) ON auth_memberships TO coreloom_background;
CREATE POLICY auth_sessions_background_policy ON auth_sessions
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON auth_sessions FROM coreloom_background;
GRANT SELECT (token_hash, tenant_id, account_id, expires_at) ON auth_sessions TO coreloom_background;
`;

export const AUTH_MIGRATION_002 = `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.manage' FROM auth_memberships WHERE role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.manage' FROM auth_memberships WHERE role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.manage' FROM auth_memberships WHERE role = 'owner'
ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope = 'system.modules.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role = 'member'
  );
`;

export const AUTH_MIGRATION_003 = `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.execute' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.manage' FROM auth_memberships WHERE role = 'owner'
ON CONFLICT DO NOTHING;
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

export const AUTH_MIGRATION_005 = `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.skills.read' FROM auth_memberships ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.providers.test' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'agents.skills.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope IN ('agents.providers.read', 'agents.providers.manage', 'agents.providers.test', 'agents.skills.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_006_TENANT_SLUG = `ALTER TABLE auth_tenants ADD COLUMN IF NOT EXISTS slug TEXT;
UPDATE auth_tenants SET slug = lower(id) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tenants_slug_idx ON auth_tenants(slug);
-- A slug is how a workspace is addressed before one is entered, so the
-- cross-tenant lookup that resolves it reads this column too.
GRANT SELECT (slug) ON auth_tenants TO coreloom_background;
`;

export const AUTH_MIGRATION_007_SANDBOX_SCOPES = `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.use' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.sessions.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.preview.data' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.modules.eject' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
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
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  last_used_at BIGINT,
  revoked_at BIGINT,
  revoked_by TEXT,
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES auth_memberships(account_id, tenant_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS auth_api_tokens_tenant_idx
  ON auth_api_tokens (tenant_id, revoked_at, created_at DESC);
ALTER TABLE auth_api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_api_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_api_tokens_tenant_policy ON auth_api_tokens
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- A bearer token names no workspace. The routing read stops at the revoked
-- flag; the scopes, label and account are read again under the tenant it named.
CREATE POLICY auth_api_tokens_background_policy ON auth_api_tokens
  FOR SELECT TO coreloom_background
  USING (revoked_at IS NULL);
REVOKE SELECT ON auth_api_tokens FROM coreloom_background;
GRANT SELECT (token_hash, tenant_id, id, revoked_at) ON auth_api_tokens TO coreloom_background;

INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.tokens.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.tokens.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
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
  updated_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, module_id, key)
);
ALTER TABLE module_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY module_settings_tenant_policy ON module_settings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope IN ('system.settings.read', 'system.settings.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_010_SIGN_IN_LOCKOUT = `-- Failures are counted per email address before a workspace, and usually before
-- an account, is known, so this table carries no tenant column and no policy.
-- locked_until holds an epoch in milliseconds, which overflows INTEGER.
CREATE TABLE IF NOT EXISTS auth_sign_in_failures (
  email_normalized TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sign_in_failures_updated_idx
  ON auth_sign_in_failures (updated_at);
`;

export const AUTH_MIGRATION_011_SESSION_IDS_AND_PASSWORD_RESET = `ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE auth_accounts ADD COLUMN IF NOT EXISTS password_change_required INTEGER NOT NULL DEFAULT 0;
UPDATE auth_sessions SET id = replace(gen_random_uuid()::text, '-', '') WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_id_idx ON auth_sessions (id);
-- Revoking one session of an account names it by this id and no workspace, so
-- the cross-tenant lookup that routes it reads this column too.
GRANT SELECT (id) ON auth_sessions TO coreloom_background;
`;

export const AUTH_MIGRATION_012_ROLES = `CREATE TABLE IF NOT EXISTS auth_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, key)
);
ALTER TABLE auth_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_roles_tenant_policy ON auth_roles
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE auth_memberships ADD COLUMN IF NOT EXISTS role_id TEXT;
-- Built-in owner and member rows are inserted per tenant by the repository from the static scope lists.
UPDATE auth_memberships SET role_id = tenant_id || ':' || role
WHERE role_id IS NULL AND role IN ('owner', 'member');
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.roles.read' FROM auth_memberships ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.roles.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
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
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_account_id TEXT,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_audit_tenant_time_idx
  ON auth_audit (tenant_id, occurred_at DESC, id DESC);
ALTER TABLE auth_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_audit_tenant_policy ON auth_audit
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'auth.audit.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope = 'auth.audit.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
`;

export const AUTH_MIGRATION_014_AUDIT_ACTOR = `ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (actor_kind IN ('user', 'agent'));
ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS actor_run_id TEXT
  CHECK (actor_run_id IS NULL OR length(actor_run_id) BETWEEN 1 AND 128);
`;

export const AUTH_MIGRATION_015_ACCOUNT_SECURITY = `-- A reset token, a TOTP secret and a recovery code belong to the account, not
-- to one of its workspaces, and each is presented before a workspace is chosen.
-- They carry no tenant column and no policy; the membership tables remain the
-- only place the workspace boundary is expressed.
CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_password_reset_tokens_account_expiry_idx
  ON auth_password_reset_tokens (account_id, expires_at, token_hash);

CREATE TABLE IF NOT EXISTS auth_tenant_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  role_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, email_normalized)
);
CREATE INDEX IF NOT EXISTS auth_tenant_invitations_tenant_expiry_idx
  ON auth_tenant_invitations (tenant_id, expires_at, id);

CREATE TABLE IF NOT EXISTS auth_mfa_totp (
  account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  confirmed_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_mfa_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_mfa_recovery_codes_account_idx
  ON auth_mfa_recovery_codes (account_id, used_at, code_hash);

CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_expiry_idx
  ON auth_mfa_challenges (expires_at, token_hash);

ALTER TABLE auth_tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tenant_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_tenant_invitations_tenant_policy ON auth_tenant_invitations
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE auth_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_mfa_challenges_tenant_policy ON auth_mfa_challenges
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- An invitation link and a pending multi-factor challenge name their workspace
-- only inside the row, so the routing read runs on the background role and the
-- acceptance that follows runs under the tenant it returned. An invitation that
-- was already accepted and a challenge that was already spent route nothing.
CREATE POLICY auth_tenant_invitations_background_policy ON auth_tenant_invitations
  FOR SELECT TO coreloom_background
  USING (accepted_at IS NULL);
REVOKE SELECT ON auth_tenant_invitations FROM coreloom_background;
GRANT SELECT (token_hash, tenant_id, expires_at, accepted_at) ON auth_tenant_invitations TO coreloom_background;
CREATE POLICY auth_mfa_challenges_background_policy ON auth_mfa_challenges
  FOR SELECT TO coreloom_background
  USING (used_at IS NULL);
REVOKE SELECT ON auth_mfa_challenges FROM coreloom_background;
GRANT SELECT (token_hash, tenant_id, account_id, expires_at, used_at) ON auth_mfa_challenges TO coreloom_background;
`;

/* The scope backfills carry no schema, so they have nothing to adopt. They also
   reach no rows: row security is forced on both tables they read, and the
   migration role is subject to it like any other, so the SELECT they insert
   from is empty on every PostgreSQL database. They stay because a migration id
   is immutable history; a workspace receives these scopes when it is created,
   from the static role lists in acl/scopes.ts. */
export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_auth_core',
		sql: { postgresql: AUTH_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_tenants',
				'auth_tenants_tenant_policy',
				[
					() => database.schema.hasTable('auth_accounts'),
					() => database.schema.hasTable('auth_memberships'),
					() => database.schema.hasTable('auth_membership_scopes'),
					() => database.schema.hasTable('auth_sessions'),
					() => database.schema.hasIndex('auth_sessions_account_idx'),
					() => database.schema.hasIndex('auth_sessions_expiry_idx'),
				],
			),
	},
	{ id: '0002_bundled_module_scopes', sql: { postgresql: AUTH_MIGRATION_002 } },
	{ id: '0003_agent_core_scopes', sql: { postgresql: AUTH_MIGRATION_003 } },
	{
		id: '0004_owner_only_development_scopes',
		sql: { postgresql: AUTH_MIGRATION_004 },
	},
	{ id: '0005_agent_provider_scopes', sql: { postgresql: AUTH_MIGRATION_005 } },
	{
		id: '0006_tenant_slug',
		sql: { postgresql: AUTH_MIGRATION_006_TENANT_SLUG },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('auth_tenants', 'slug'),
				() => database.schema.hasIndex('auth_tenants_slug_idx'),
			]),
	},
	{
		id: '0007_sandbox_scopes',
		sql: { postgresql: AUTH_MIGRATION_007_SANDBOX_SCOPES },
	},
	{
		id: '0008_api_tokens',
		sql: { postgresql: AUTH_MIGRATION_008_API_TOKENS },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_api_tokens',
				'auth_api_tokens_tenant_policy',
				[() => database.schema.hasIndex('auth_api_tokens_tenant_idx')],
			),
	},
	{
		id: '0009_module_settings',
		sql: { postgresql: AUTH_MIGRATION_009_MODULE_SETTINGS },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'module_settings',
				'module_settings_tenant_policy',
			),
	},
	{
		id: '0010_sign_in_lockout',
		sql: { postgresql: AUTH_MIGRATION_010_SIGN_IN_LOCKOUT },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasTable('auth_sign_in_failures'),
				() => database.schema.hasIndex('auth_sign_in_failures_updated_idx'),
			]),
	},
	{
		id: '0011_session_ids_and_password_reset',
		sql: { postgresql: AUTH_MIGRATION_011_SESSION_IDS_AND_PASSWORD_RESET },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('auth_sessions', 'id'),
				() =>
					database.schema.hasColumn(
						'auth_accounts',
						'password_change_required',
					),
				() => database.schema.hasIndex('auth_sessions_id_idx'),
			]),
	},
	{
		id: '0012_roles',
		sql: { postgresql: AUTH_MIGRATION_012_ROLES },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_roles',
				'auth_roles_tenant_policy',
				[() => database.schema.hasColumn('auth_memberships', 'role_id')],
			),
	},
	{
		id: '0013_audit',
		sql: { postgresql: AUTH_MIGRATION_013_AUDIT },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_audit',
				'auth_audit_tenant_policy',
				[() => database.schema.hasIndex('auth_audit_tenant_time_idx')],
			),
	},
	{
		id: '0014_audit_actor',
		sql: { postgresql: AUTH_MIGRATION_014_AUDIT_ACTOR },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('auth_audit', 'actor_kind'),
				() => database.schema.hasColumn('auth_audit', 'actor_run_id'),
			]),
	},
	{
		id: '0015_account_security',
		sql: { postgresql: AUTH_MIGRATION_015_ACCOUNT_SECURITY },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_tenant_invitations',
				'auth_tenant_invitations_tenant_policy',
				[
					() => database.schema.hasTable('auth_password_reset_tokens'),
					() => database.schema.hasTable('auth_mfa_totp'),
					() => database.schema.hasTable('auth_mfa_recovery_codes'),
					() => database.schema.hasTable('auth_mfa_challenges'),
					() => database.schema.hasIndex('auth_mfa_challenges_expiry_idx'),
				],
			),
	},
];
