-- A reset token, a TOTP secret and a recovery code belong to the account, not
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
