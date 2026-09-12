-- The retention sweep of approvals.core.requests asks one workspace for its
-- oldest resolved requests, the export walks every request of a workspace in
-- id order, and a subject erasure asks it for the decisions one account made.
-- None of the three is covered by what the module already carries: the status
-- index orders by creation rather than by resolution, the requester index
-- answers who asked rather than who decided, and no index carries the export's
-- own key order. All three are bounded batches, so all three need a range scan
-- rather than a pass over the workspace's requests.
CREATE INDEX IF NOT EXISTS approvals_requests_resolved_idx
  ON approvals_requests (tenant_id, status, resolved_at, id);
CREATE INDEX IF NOT EXISTS approvals_requests_export_idx
  ON approvals_requests (tenant_id, id);
CREATE INDEX IF NOT EXISTS approvals_decisions_decider_account_idx
  ON approvals_decisions (tenant_id, decider_account_id, id);
