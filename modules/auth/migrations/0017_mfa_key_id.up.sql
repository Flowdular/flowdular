-- The TOTP envelope in secret_ciphertext names no key, so rotating
-- FD_AUTH_MFA_KEY could only be recovered by re-enrolling every account. This
-- column records the key that sealed the row. A row written before it keeps
-- NULL and is opened by trying the ring in order until auth secrets-rotate
-- re-seals it; the envelope bytes themselves are unchanged. The factor belongs
-- to the account, not to one of its workspaces, so the table carries no tenant
-- column and no policy, exactly as 0015 created it.
ALTER TABLE auth_mfa_totp ADD COLUMN IF NOT EXISTS key_id TEXT;
