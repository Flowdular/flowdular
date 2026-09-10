CREATE INDEX IF NOT EXISTS workflow_runs_claim_idx
  ON workflow_runs (mode, status, lease_expires_at, queued_at, id);
CREATE INDEX IF NOT EXISTS workflow_payloads_retention_idx
  ON workflow_payloads (kind, expires_at, id);
-- The worker has to find due work before it knows whose it is, and retention
-- sweeps every tenant. Both are granted exactly the columns that route the
-- work and nothing else: graphs, inputs, actors, permission snapshots and
-- payload ciphertext stay unreadable on this connection. Whatever acts on a
-- row reads it again under the tenant that row named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY workflow_runs_background_policy ON workflow_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON workflow_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, mode, status, lease_expires_at, queued_at)
  ON workflow_runs TO coreloom_background;
CREATE POLICY workflow_node_states_background_policy ON workflow_node_states
  FOR SELECT TO coreloom_background
  USING (status = 'waiting-retry');
REVOKE SELECT ON workflow_node_states FROM coreloom_background;
GRANT SELECT (tenant_id, run_id, status, next_attempt_at)
  ON workflow_node_states TO coreloom_background;
CREATE POLICY workflow_payloads_background_policy ON workflow_payloads
  FOR SELECT TO coreloom_background
  USING (kind = 'execution' AND expires_at IS NOT NULL);
REVOKE SELECT ON workflow_payloads FROM coreloom_background;
GRANT SELECT (tenant_id, id, run_id, kind, payload_hash, expires_at)
  ON workflow_payloads TO coreloom_background;
