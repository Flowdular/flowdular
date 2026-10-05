-- Reversal discards the separate external side-effect key. Stop all action
-- workers and reconcile queued invocations before applying it.
ALTER TABLE agent_action_invocations
  DROP COLUMN side_effect_idempotency_key;
