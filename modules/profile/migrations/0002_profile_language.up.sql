CREATE TABLE IF NOT EXISTS profile_language_preferences (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
) STRICT;
