CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
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
