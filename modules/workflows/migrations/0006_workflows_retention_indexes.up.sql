-- The retention sweep of workflows.core.runs asks one workspace for its oldest
-- settled runs, and a subject erasure asks it for the runs one account
-- requested. Both are bounded batches, so both need a range scan rather than a
-- pass over the workspace's runs. The requester lives inside the stored actor
-- document, so the index is over that one field of it; the export walks the
-- order workflow_runs_tenant_queue_idx already carries and needs no index of
-- its own.
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_settled_idx
  ON workflow_runs (tenant_id, completed_at);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_requester_idx
  ON workflow_runs (tenant_id, (actor_json::jsonb ->> 'id'), id);
