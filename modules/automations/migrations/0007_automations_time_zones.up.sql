-- The workspace zone cron slots follow, recorded by the process that accepted
-- the change. A row whose applied_time_zone differs from time_zone is a
-- retiming the scheduler still owes that workspace.
CREATE TABLE IF NOT EXISTS automations_time_zones (
  tenant_id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  changed_at BIGINT NOT NULL,
  applied_time_zone TEXT CHECK (char_length(applied_time_zone) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS automations_time_zones_pending_idx
  ON automations_time_zones (tenant_id)
  WHERE applied_time_zone IS DISTINCT FROM time_zone;
ALTER TABLE automations_time_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_time_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_time_zones_tenant_policy ON automations_time_zones
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The scheduler pass finds the workspaces that owe a retiming across tenants.
-- It is granted the tenant id alone and its policy shows it only those rows;
-- the zone is read again under the tenant this returned.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY automations_time_zones_background_policy ON automations_time_zones
  FOR SELECT TO coreloom_background
  USING (applied_time_zone IS DISTINCT FROM time_zone);
GRANT SELECT (tenant_id) ON automations_time_zones TO coreloom_background;
