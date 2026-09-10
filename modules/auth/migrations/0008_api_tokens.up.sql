CREATE TABLE IF NOT EXISTS auth_api_tokens (
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
