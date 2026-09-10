CREATE TABLE IF NOT EXISTS auth_tenants (
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
