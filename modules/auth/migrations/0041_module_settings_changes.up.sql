-- Every process served settings from a snapshot only the writing process
-- refreshed, and the settings audit was written by a listener after the commit,
-- so other processes kept stale values and a crash between the two lost the
-- event. Every save or clear now appends one row here in the transaction that
-- writes the value. A row names the setting that changed, never its value, so
-- no secret enters the log. The revision comes from one sequence for every
-- tenant and the platform; the store takes one transaction-scoped lock before
-- it draws one, so revisions commit in the order they are drawn.
CREATE TABLE IF NOT EXISTS module_settings_changes (
  revision BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  cleared INTEGER NOT NULL CHECK (cleared IN (0, 1)),
  changed_at BIGINT NOT NULL,
  changed_by TEXT NOT NULL,
  origin_tenant_id TEXT,
  audit_pending INTEGER NOT NULL DEFAULT 0 CHECK (audit_pending IN (0, 1)),
  CHECK (audit_pending = 0 OR origin_tenant_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS module_settings_changes_key_idx
  ON module_settings_changes (module_id, key, revision);
CREATE INDEX IF NOT EXISTS module_settings_changes_setting_idx
  ON module_settings_changes (tenant_id, module_id, key, revision);
CREATE INDEX IF NOT EXISTS module_settings_changes_age_idx
  ON module_settings_changes (changed_at, tenant_id);
CREATE INDEX IF NOT EXISTS module_settings_changes_audit_pending_idx
  ON module_settings_changes (tenant_id, revision) WHERE audit_pending = 1;
-- A reader starting from the beginning sees every value already stored: one
-- change per stored value, at its stored time and by its stored author. The
-- workspace a platform value was saved from was never stored, so it stays
-- unknown. module_settings forces row security on its owner as well, so the
-- flag is lifted for the read and restored in the same transaction.
ALTER TABLE module_settings NO FORCE ROW LEVEL SECURITY;
INSERT INTO module_settings_changes
  (tenant_id, module_id, key, cleared, changed_at, changed_by, origin_tenant_id)
SELECT tenant_id, module_id, key, 0, updated_at, updated_by,
       CASE WHEN tenant_id = 'auth.core:platform' THEN NULL ELSE tenant_id END
         AS origin_tenant_id
FROM module_settings
ORDER BY updated_at, tenant_id, module_id, key;
ALTER TABLE module_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE module_settings_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_settings_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY module_settings_changes_tenant_policy ON module_settings_changes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- Workers in other processes read the log across tenants. The background role
-- sees every row through a policy of its own but only the columns that say
-- which setting changed and when; who changed it, the workspace it came from
-- and the audit mark stay unreadable, and it writes nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY module_settings_changes_background_policy ON module_settings_changes
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE ALL ON module_settings_changes FROM coreloom_background;
GRANT SELECT (revision, tenant_id, module_id, key, cleared, changed_at) ON module_settings_changes TO coreloom_background;
-- A platform setting's event belongs to the workspace it was saved from, which
-- a second transaction writes. The revision it carries is unique per
-- workspace, so a retried write of the same change lands once.
ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS settings_revision BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS auth_audit_settings_revision_idx
  ON auth_audit (tenant_id, settings_revision)
  WHERE settings_revision IS NOT NULL;
