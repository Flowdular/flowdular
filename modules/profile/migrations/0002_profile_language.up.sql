CREATE TABLE IF NOT EXISTS profile_language_preferences (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
ALTER TABLE profile_language_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_language_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_language_preferences_tenant_policy ON profile_language_preferences
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
