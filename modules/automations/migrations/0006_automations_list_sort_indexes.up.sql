-- The schedule and trigger lists page by keyset over the same order they show,
-- lower(label) then id, or updated_at then id, so each order gets an index
-- that starts with the tenant and ends with the id the keyset breaks ties on.
CREATE INDEX IF NOT EXISTS automations_schedules_tenant_label_key_idx
  ON automations_schedules (tenant_id, lower(label), id);
CREATE INDEX IF NOT EXISTS automations_schedules_tenant_updated_idx
  ON automations_schedules (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS automations_triggers_tenant_label_key_idx
  ON automations_triggers (tenant_id, lower(label), id);
CREATE INDEX IF NOT EXISTS automations_triggers_tenant_updated_idx
  ON automations_triggers (tenant_id, updated_at, id);
