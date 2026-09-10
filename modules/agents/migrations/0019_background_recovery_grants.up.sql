-- The worker recovery polls have to find interrupted work before they know
-- whose it is, so they read on the background role. That role gets no table
-- privilege by default: each table it may poll grants the routing columns it
-- needs and nothing else, under a policy of its own. Every claim that follows
-- runs on the tenant-scoped runtime role, under the tenant the row named.
CREATE POLICY agent_runs_background_policy ON agent_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_runs FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_runs TO coreloom_background;
CREATE POLICY agent_action_invocations_background_policy ON agent_action_invocations
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_action_invocations FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_action_invocations TO coreloom_background;
