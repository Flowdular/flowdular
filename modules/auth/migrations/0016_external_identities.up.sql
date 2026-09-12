-- An external provider asserts an identity about an account, not about one of
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
