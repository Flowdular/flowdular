-- The operator status command counts provider connections across the whole
-- deployment, which the tenant-scoped runtime role cannot do and should not.
-- It reads the one flag the count needs, under a policy of this table's own,
-- and never sees a name, a base URL or an encrypted credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY agent_provider_connections_background_policy
  ON agent_provider_connections
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_provider_connections FROM coreloom_background;
GRANT SELECT (id, enabled) ON agent_provider_connections TO coreloom_background;
