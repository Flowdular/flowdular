CREATE INDEX IF NOT EXISTS automations_schedules_routing_idx
  ON automations_schedules (enabled, next_run_at, tenant_id, id);
-- The scheduler must find due work across tenants. It is granted exactly the
-- columns the poll reads and nothing else: labels, templates, the configuring
-- actor and the permission snapshot stay invisible to it, and the schedule is
-- read again under its own tenant before anything acts on it. PostgreSQL checks
-- column privileges in WHERE too, so `enabled` is part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY automations_schedules_background_policy ON automations_schedules
  FOR SELECT TO coreloom_background
  USING (enabled = 1);
REVOKE SELECT ON automations_schedules FROM coreloom_background;
GRANT SELECT (tenant_id, id, next_run_at, enabled) ON automations_schedules TO coreloom_background;
