-- The retention sweep of agents.core.runs asks one workspace for its oldest
-- settled runs, and a subject erasure asks it for the runs one account
-- requested. Both are bounded batches, so both need a range scan rather than a
-- pass over the workspace's runs; the export walks the order
-- agent_runs_tenant_queued_idx already carries and needs no index of its own.
CREATE INDEX IF NOT EXISTS agent_runs_tenant_settled_idx
  ON agent_runs (tenant_id, completed_at);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_requested_idx
  ON agent_runs (tenant_id, requested_by, id);
