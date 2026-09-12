-- A run waiting on a person waits for days, not for the seconds an agent or an
-- action takes. Leaving it in 'running' would keep it at the head of the claim
-- queue, where it would be re-claimed every poll and, because the queue is
-- ordered by queued_at, would starve every run queued after it.
--
-- 'waiting-approval' is the status that takes such a run out of the queue. It
-- comes back when approvals.core calls back, which sets the node's
-- next_attempt_at to now, or when the recheck the node armed falls due; the
-- claim predicate reads that column exactly as it already does for a retry.
--
-- The approval itself is the third child kind. It reuses the attempt's
-- waiting-child machinery, so the request id is stored in child_id and recovery
-- after a restart finds the open request instead of opening a second one.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check
  CHECK (status IN ('queued', 'running', 'waiting-agent', 'waiting-approval', 'waiting-retry', 'cancel-requested', 'succeeded', 'failed', 'refused', 'cancelled'));
ALTER TABLE workflow_node_attempts DROP CONSTRAINT IF EXISTS workflow_node_attempts_child_kind_check;
ALTER TABLE workflow_node_attempts ADD CONSTRAINT workflow_node_attempts_child_kind_check
  CHECK (child_kind IN ('agent', 'action', 'approval'));
-- The claim poll has to see that a node is asleep on an approval before it can
-- decide whether the run is due, and the cross-tenant policy showed it retries
-- only. It is widened to the second waiting state and no further: the four
-- routing columns it was already granted stay the whole of what it can read,
-- and the run is read again under its own tenant before anything is written.
DROP POLICY IF EXISTS workflow_node_states_background_policy ON workflow_node_states;
CREATE POLICY workflow_node_states_background_policy ON workflow_node_states
  FOR SELECT TO coreloom_background
  USING (status IN ('waiting-retry', 'waiting-child'));
