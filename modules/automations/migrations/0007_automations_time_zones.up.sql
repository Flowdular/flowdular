-- The newest workspace time zone change the scheduler applied to that
-- workspace's pending cron slots. The zone itself stays the system.core
-- setting; a pass retimes a workspace whose change in the settings log is
-- newer than applied_revision, under a lock on this row.
CREATE TABLE IF NOT EXISTS automations_time_zones (
  tenant_id TEXT PRIMARY KEY,
  applied_revision BIGINT NOT NULL CHECK (applied_revision >= 0),
  changed_at BIGINT NOT NULL,
  applied_at BIGINT NOT NULL
);
ALTER TABLE automations_time_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_time_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_time_zones_tenant_policy ON automations_time_zones
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
