-- An action invocation is one workflow attempt. Its unique idempotency key
-- deduplicates that attempt, while the external tool must reuse one stable key
-- across attempts so a provider mutation is never repeated after recovery.
ALTER TABLE agent_action_invocations
  ADD COLUMN side_effect_idempotency_key TEXT;
UPDATE agent_action_invocations
SET side_effect_idempotency_key = idempotency_key
WHERE side_effect_idempotency_key IS NULL;
ALTER TABLE agent_action_invocations
  ALTER COLUMN side_effect_idempotency_key SET NOT NULL;
