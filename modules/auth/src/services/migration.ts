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

export const AUTH_MIGRATION_016_EXTERNAL_IDENTITIES = `-- An external provider asserts an identity about an account, not about one of
-- its workspaces, and it does so before a workspace is chosen. The row carries
-- no tenant column and no policy, exactly like the enrolled factor tables; the
-- membership tables remain the only place the workspace boundary is expressed.
-- The (provider, subject) pair is the identity the provider promises to keep
-- stable, so it is the primary key; the address it reports is not.
CREATE TABLE IF NOT EXISTS auth_external_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS auth_external_identities_account_idx
  ON auth_external_identities (account_id, provider, subject);
`;

export const AUTH_MIGRATION_017_MFA_KEY_ID = `-- The TOTP envelope in secret_ciphertext names no key, so rotating
-- FD_AUTH_MFA_KEY could only be recovered by re-enrolling every account. This
-- column records the key that sealed the row. A row written before it keeps
-- NULL and is opened by trying the ring in order until auth secrets-rotate
-- re-seals it; the envelope bytes themselves are unchanged. The factor belongs
-- to the account, not to one of its workspaces, so the table carries no tenant
-- column and no policy, exactly as 0015 created it.
ALTER TABLE auth_mfa_totp ADD COLUMN IF NOT EXISTS key_id TEXT;
`;

export const AUTH_MIGRATION_018_RETIRE_BUNDLED_MODULE_SCOPES = `-- The parties and catalog modules no longer ship, and their read and manage
-- scopes are still granted to memberships created while they did. A grant that
-- nothing declares is a grant nobody reviews, so both pairs are retired here.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables
-- fails here loudly instead of leaving the grants in place. Nothing else runs
-- against them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('parties.records.read', 'parties.records.manage', 'catalog.items.read', 'catalog.items.manage');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a retired scope left in one comes back on the next
-- assignment. Only rows that still name one are rewritten, and their order is
-- preserved.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('parties.records.read', 'parties.records.manage', 'catalog.items.read', 'catalog.items.manage')),
      '[]')
WHERE scopes_json LIKE '%"parties.records.%'
   OR scopes_json LIKE '%"catalog.items.%';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_019_NOTIFICATIONS_MEMBER_SCOPES = `-- notifications.core declares five permissions. Owners receive all five through
-- auth sync-scopes, which module enable runs; members receive none, because the
-- member defaults live in acl/scopes.ts and a built-in role row is seeded once,
-- with ON CONFLICT DO NOTHING, when the workspace is created. So a workspace
-- that already exists would never see the three member scopes. This grants them.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['notifications.inbox.read', 'notifications.inbox.manage', 'notifications.webhooks.read']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in member row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing ones are appended in the order acl/scopes.ts declares
-- them, which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['notifications.inbox.read', 'notifications.inbox.manage', 'notifications.webhooks.read'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_020_IDENTITY_PROVIDERS = `-- A workspace may offer OIDC providers of its own beside the platform providers
-- FD_AUTH_OIDC_PROVIDERS configures at boot. Such a provider is workspace data,
-- so the row carries the tenant column and the forced policy every
-- workspace-owned table carries. The client secret is stored only as the sealed
-- envelope the auth keyring writes, beside the id of the key that sealed it, so
-- auth secrets-rotate re-seals these rows exactly as it re-seals enrolled
-- factors. The discovery endpoints are stored because they are what discovery
-- answered when the issuer was verified, not administrator input; keeping them
-- means a sign-in costs no outbound discovery request.
CREATE TABLE IF NOT EXISTS auth_identity_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  user_info_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_key_id TEXT NOT NULL,
  client_secret_fingerprint TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  jit_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  jit_role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS auth_identity_providers_tenant_idx
  ON auth_identity_providers (tenant_id, key, id);
ALTER TABLE auth_identity_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identity_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_identity_providers_tenant_policy ON auth_identity_providers
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A platform provider asserts an identity about an account before any workspace
-- is chosen, and keeps binding without one. A tenant-owned provider asserts it
-- inside its own workspace only, so the binding carries that workspace and the
-- pair (provider, subject) is unique per workspace rather than globally. The
-- primary key 0016 put on the pair would let one workspace's binding block
-- another's, so it goes and two partial unique indexes take its place.
ALTER TABLE auth_external_identities
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES auth_tenants(id) ON DELETE CASCADE;
ALTER TABLE auth_external_identities
  DROP CONSTRAINT IF EXISTS auth_external_identities_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS auth_external_identities_platform_idx
  ON auth_external_identities (provider, subject) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_external_identities_workspace_idx
  ON auth_external_identities (tenant_id, provider, subject) WHERE tenant_id IS NOT NULL;
-- The workspace rows are workspace data and the policy scopes them to their
-- tenant; the platform rows carry no workspace and stay readable under the
-- identity context that has always written them.
ALTER TABLE auth_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_external_identities_tenant_policy ON auth_external_identities
  USING (tenant_id IS NULL OR tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const AUTH_MIGRATION_022_AUTH_PROVIDER_SCOPES = `-- auth.core declares auth.providers.read and auth.providers.manage for the
-- workspace identity providers screen. A module's scopes reach existing owners
-- through auth sync-scopes, which module enable runs, but auth.core is not a
-- module a deployment enables, and the built-in role rows are seeded once, with
-- ON CONFLICT DO NOTHING, when a workspace is created. So a workspace that
-- already exists would never see either scope. This grants them.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['auth.providers.read', 'auth.providers.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in owner row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing ones are appended in the order acl/scopes.ts declares
-- them, which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['auth.providers.read', 'auth.providers.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_021_MEMBERSHIP_STATUS = `-- Membership status is per workspace: disabling a member in one workspace
-- revokes that membership's sessions and tokens and refuses its sign-in, and
-- leaves the person's other memberships untouched. The account status column
-- stays what it was, the deployment operator's platform-level block.
ALTER TABLE auth_memberships ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_memberships_status_check'
  ) THEN
    ALTER TABLE auth_memberships ADD CONSTRAINT auth_memberships_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;
END
$$;
-- A session cookie, a bearer token and an email address name no workspace, so
-- the routing read decides which membership answers for them. A disabled
-- membership must not be that answer, which is a column this role now reads.
GRANT SELECT (status) ON auth_memberships TO coreloom_background;
`;

export const AUTH_MIGRATION_023_ENTERPRISE_MODULE_SCOPES = `-- directory.core, audit.core, approvals.core, documents.core, metering.core,
-- import.core, search.core and connectors.core declare sixteen permissions
-- between them. Owners receive a module's scopes through auth sync-scopes,
-- which module enable runs, so only where that module is enabled; members
-- receive none, because the member defaults live in acl/scopes.ts and a
-- built-in role row is seeded once, with ON CONFLICT DO NOTHING, when the
-- workspace is created. So a workspace that already exists would see neither
-- the owner defaults of a module it never enabled nor any member default. This
-- grants both, in the order acl/scopes.ts declares them.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['directory.tokens.read', 'directory.tokens.manage', 'directory.provisioning.read', 'audit.registry.read', 'audit.retention.manage', 'approvals.requests.read', 'approvals.requests.decide', 'approvals.requests.manage', 'documents.files.read', 'documents.files.manage', 'metering.usage.read', 'import.jobs.read', 'import.jobs.manage', 'search.records.read', 'connectors.instances.read', 'connectors.instances.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['documents.files.read', 'documents.files.manage', 'search.records.read', 'connectors.instances.read']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from a built-in row would be taken
-- away again at the next assignment. The scopes already held keep their order
-- and the missing ones are appended in the order acl/scopes.ts declares them,
-- which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['directory.tokens.read', 'directory.tokens.manage', 'directory.provisioning.read', 'audit.registry.read', 'audit.retention.manage', 'approvals.requests.read', 'approvals.requests.decide', 'approvals.requests.manage', 'documents.files.read', 'documents.files.manage', 'metering.usage.read', 'import.jobs.read', 'import.jobs.manage', 'search.records.read', 'connectors.instances.read', 'connectors.instances.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['documents.files.read', 'documents.files.manage', 'search.records.read', 'connectors.instances.read'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_024_APPROVALS_MEMBER_SCOPES = `-- approvals.core resolves the deciders of a request from the workspace roles,
-- so a member has to read the requests that name them and record a decision on
-- them. 0023 granted the three approval scopes to owners alone, which was the
-- member default at the time; acl/scopes.ts now carries approvals.requests.read
-- and approvals.requests.decide among the member defaults, and a built-in role
-- row is seeded once, with ON CONFLICT DO NOTHING, when the workspace is
-- created. So a workspace that already exists would never see either. This
-- grants both to its members, in the order acl/scopes.ts declares them. Owners
-- keep what 0023 gave them and are not touched here.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['approvals.requests.read', 'approvals.requests.decide']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in member row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing ones are appended in the order acl/scopes.ts declares
-- them, which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['approvals.requests.read', 'approvals.requests.decide'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_025_AUDIT_HOLDS_OWNER_SCOPE = `-- audit.core declares audit.holds.manage, and D-AUDIT-HOLD-PERMISSION keeps it
-- with owners: only an owner places or lifts a legal hold. The permission was
-- declared after 0023 backfilled the enterprise module scopes, so an existing
-- workspace carries it on neither its owner memberships nor its built-in owner
-- role row. auth sync-scopes grants a module's declared scopes when the module
-- is enabled, and audit.core was already enabled when this one appeared, so
-- that path does not reach it either. This grants it to every owner
-- membership and appends it to the built-in owner role row. Members receive
-- nothing here: D-AUDIT-PERMISSIONS keeps every audit permission owner-only.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['audit.holds.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in owner row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing one is appended.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['audit.holds.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_026_AUTH_EXPORT_KEYSET_INDEXES = `-- The three data class export walks page one workspace by keyset:
-- WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3. No index ordered that
-- pair, so every page sorted the whole workspace again: auth_sessions carried
-- (account_id, expires_at), (expires_at) and a unique (id); auth_api_tokens
-- (tenant_id, revoked_at, created_at DESC); auth_audit
-- (tenant_id, occurred_at DESC, id DESC). These three turn each page into an
-- index range scan of exactly the rows it returns, which is what makes an
-- export of a large workspace linear in the rows it carries rather than
-- quadratic in them.
CREATE INDEX IF NOT EXISTS auth_sessions_tenant_keyset_idx
  ON auth_sessions (tenant_id, id);
CREATE INDEX IF NOT EXISTS auth_api_tokens_tenant_keyset_idx
  ON auth_api_tokens (tenant_id, id);
CREATE INDEX IF NOT EXISTS auth_audit_tenant_keyset_idx
  ON auth_audit (tenant_id, id);
`;

export const AUTH_MIGRATION_027_WORKFLOW_AUTOMATION_PROFILE_SCOPES = `-- workflows.core, automations.core and profile.core declare eleven permissions
-- between them, and owners hold every permission an enabled module declares.
-- All three were already enabled when the owner defaults gained them, so auth
-- sync-scopes does not reach an existing workspace: it grants a module's scopes
-- when the module is enabled and to the workspaces that exist at that moment.
-- The seed lists in acl/scopes.ts reach a workspace created from now on and no
-- earlier one. This grants the eleven to every owner membership and appends
-- them to the built-in owner role row. Members receive profile.self.manage
-- alone, because every member manages their own profile, language, password
-- and sessions, while the workflow and automation permissions stay with owners.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['profile.self.manage']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from a built-in row would be taken
-- away again at the next assignment. The scopes already held keep their order
-- and the missing ones are appended in the order acl/scopes.ts declares them,
-- which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['profile.self.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_028_AUTH_MEMBER_SEARCH_PREFIX_INDEXES = `-- Member search matched a display name anywhere, LIKE '%term%', which no index
-- can answer: every keystroke read the workspace and sorted it before the LIMIT
-- cut it. Both branches are prefixes now, and these indexes turn each branch
-- into a range scan of the rows it returns. The ordering is still a sort, over
-- the rows the prefix matched rather than over the workspace.
--
-- The operator class is the load-bearing part. A btree over text in any
-- collation but C orders by that collation, while LIKE 'term%' is a range in
-- byte order, so an index in the database's default collation is ignored on a
-- deployment created with a locale and the workspace scan comes back unnoticed.
-- text_pattern_ops states the byte order the prefix needs, so the same plan
-- holds under every collation. The unique index on email_normalized stays the
-- key it is; it answers equality, and under C collation the prefix as well.
--
-- Neither index carries a workspace column because auth_accounts carries none.
-- A search reaches an account through auth_memberships, whose policy and
-- primary key bind the workspace to it.
CREATE INDEX IF NOT EXISTS auth_accounts_display_name_prefix_idx
  ON auth_accounts (lower(display_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS auth_accounts_email_prefix_idx
  ON auth_accounts (email_normalized text_pattern_ops);
`;

export const AUTH_MIGRATION_029_REPORTS_EXPORTS_ACCESS_SCOPES = `-- reports.core, exports.core and access.core declare five permissions between
-- them, and owners hold every permission an enabled module declares. All three
-- were already enabled when the owner defaults gained them, so auth sync-scopes
-- does not reach an existing workspace: it grants a module's scopes when the
-- module is enabled and to the workspaces that exist at that moment. The seed
-- lists in acl/scopes.ts reach a workspace created from now on and no earlier
-- one. This grants the five to every owner membership and appends them to the
-- built-in owner role row.
--
-- Members receive none of them. D-REPORTS-AUDIENCE keeps the workspace report
-- with owners because it composes spend, usage and volume across modules;
-- D-OWNERS-ONLY keeps both access review permissions with owners because the
-- review names every scope, token and provider of the workspace; and
-- D-EXPORTS-PERMISSIONS states what starting an export and opening a file
-- require of the live principal rather than granting a role anything, so the
-- two export permissions stay owner defaults and a workspace that wants a
-- member to export assigns a role carrying them.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['reports.workspace.read', 'exports.lists.read', 'exports.lists.manage', 'access.review.read', 'access.review.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in owner row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing ones are appended in the order acl/scopes.ts declares
-- them, which is the order a freshly seeded workspace writes.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['reports.workspace.read', 'exports.lists.read', 'exports.lists.manage', 'access.review.read', 'access.review.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
`;

export const AUTH_MIGRATION_030_AUTH_MEMBERSHIP_KEYSET_INDEX = `-- The paged member read walks one workspace by keyset:
-- WHERE tenant_id = $1 AND account_id > $2 ORDER BY account_id LIMIT $3. The
-- primary key of auth_memberships is (account_id, tenant_id), which leads with
-- the account, so that walk is a scan over every workspace's rows after the
-- cursor with the workspace applied as a filter. This index leads with the
-- workspace, which turns each page into an index range scan of exactly the
-- rows it returns and makes the walk linear in the members it carries rather
-- than in the deployment.
CREATE INDEX IF NOT EXISTS auth_memberships_tenant_keyset_idx
  ON auth_memberships (tenant_id, account_id);
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
	{
		id: '0016_external_identities',
		sql: { postgresql: AUTH_MIGRATION_016_EXTERNAL_IDENTITIES },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasTable('auth_external_identities'),
				() => database.schema.hasIndex('auth_external_identities_account_idx'),
			]),
	},
	{
		id: '0017_mfa_key_id',
		sql: { postgresql: AUTH_MIGRATION_017_MFA_KEY_ID },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('auth_mfa_totp', 'key_id'),
			]),
	},
	/* A data-only retirement: there is no schema object to prove, and a probe
	   over the rows would report a fresh database as adopted. It cannot predate
	   the ledger either, so it declares no inspectExisting. */
	{
		id: '0018_retire_bundled_module_scopes',
		sql: { postgresql: AUTH_MIGRATION_018_RETIRE_BUNDLED_MODULE_SCOPES },
	},
	/* Data-only like 0018, and for the same reason it declares no
	   inspectExisting: a probe over the rows would report a fresh database, which
	   receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0019_notifications_member_scopes',
		sql: { postgresql: AUTH_MIGRATION_019_NOTIFICATIONS_MEMBER_SCOPES },
	},
	{
		id: '0020_identity_providers',
		sql: { postgresql: AUTH_MIGRATION_020_IDENTITY_PROVIDERS },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'auth_identity_providers',
				'auth_identity_providers_tenant_policy',
				[
					() => database.schema.hasIndex('auth_identity_providers_tenant_idx'),
					() =>
						database.schema.hasColumn('auth_external_identities', 'tenant_id'),
					() =>
						database.schema.hasIndex('auth_external_identities_workspace_idx'),
				],
			),
	},
	{
		id: '0021_membership_status',
		sql: { postgresql: AUTH_MIGRATION_021_MEMBERSHIP_STATUS },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('auth_memberships', 'status'),
			]),
	},
	/* Data-only like 0018 and 0019, and for the same reason it declares no
	   inspectExisting: a probe over the rows would report a fresh database, which
	   receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0022_auth_provider_scopes',
		sql: { postgresql: AUTH_MIGRATION_022_AUTH_PROVIDER_SCOPES },
	},
	/* Data-only like 0018, 0019 and 0022, and for the same reason it declares no
	   inspectExisting: a probe over the rows would report a fresh database, which
	   receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0023_enterprise_module_scopes',
		sql: { postgresql: AUTH_MIGRATION_023_ENTERPRISE_MODULE_SCOPES },
	},
	/* Data-only like 0018, 0019, 0022 and 0023, and for the same reason it
	   declares no inspectExisting: a probe over the rows would report a fresh
	   database, which receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0024_approvals_member_scopes',
		sql: { postgresql: AUTH_MIGRATION_024_APPROVALS_MEMBER_SCOPES },
	},
	/* Data-only like 0018, 0019, 0022, 0023 and 0024, and for the same reason it
	   declares no inspectExisting: a probe over the rows would report a fresh
	   database, which receives this scope from acl/scopes.ts, as adopted. */
	{
		id: '0025_audit_holds_owner_scope',
		sql: { postgresql: AUTH_MIGRATION_025_AUDIT_HOLDS_OWNER_SCOPE },
	},
	{
		id: '0026_auth_export_keyset_indexes',
		sql: { postgresql: AUTH_MIGRATION_026_AUTH_EXPORT_KEYSET_INDEXES },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('auth_sessions_tenant_keyset_idx'),
				() => database.schema.hasIndex('auth_api_tokens_tenant_keyset_idx'),
				() => database.schema.hasIndex('auth_audit_tenant_keyset_idx'),
			]),
	},
	/* Data-only like 0018, 0019, 0022, 0023, 0024 and 0025, and for the same
	   reason it declares no inspectExisting: a probe over the rows would report a
	   fresh database, which receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0027_workflow_automation_profile_scopes',
		sql: { postgresql: AUTH_MIGRATION_027_WORKFLOW_AUTOMATION_PROFILE_SCOPES },
	},
	{
		id: '0028_auth_member_search_prefix_indexes',
		sql: { postgresql: AUTH_MIGRATION_028_AUTH_MEMBER_SEARCH_PREFIX_INDEXES },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('auth_accounts_display_name_prefix_idx'),
				() => database.schema.hasIndex('auth_accounts_email_prefix_idx'),
			]),
	},
	/* Data-only like 0018, 0019, 0022, 0023, 0024, 0025 and 0027, and for the same
	   reason it declares no inspectExisting: a probe over the rows would report a
	   fresh database, which receives these scopes from acl/scopes.ts, as adopted. */
	{
		id: '0029_reports_exports_access_scopes',
		sql: { postgresql: AUTH_MIGRATION_029_REPORTS_EXPORTS_ACCESS_SCOPES },
	},
	{
		id: '0030_auth_membership_keyset_index',
		sql: { postgresql: AUTH_MIGRATION_030_AUTH_MEMBERSHIP_KEYSET_INDEX },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('auth_memberships_tenant_keyset_idx'),
			]),
	},
];
