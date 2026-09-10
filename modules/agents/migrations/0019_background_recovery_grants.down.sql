REVOKE SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_action_invocations FROM coreloom_background;
DROP POLICY agent_action_invocations_background_policy ON agent_action_invocations;
REVOKE SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_runs FROM coreloom_background;
DROP POLICY agent_runs_background_policy ON agent_runs;
