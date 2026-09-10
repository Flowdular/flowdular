CREATE INDEX IF NOT EXISTS automations_triggers_routing_idx
  ON automations_triggers (id, tenant_id);
-- A webhook arrives with a trigger id and no tenant, so the lookup must cross
-- tenants. It is granted exactly the two columns that route it: the secret, the
-- label, the target and the permission snapshot are read again under the tenant
-- this returned, before anything is verified or fired.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY automations_triggers_background_policy ON automations_triggers
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON automations_triggers FROM coreloom_background;
GRANT SELECT (tenant_id, id) ON automations_triggers TO coreloom_background;
