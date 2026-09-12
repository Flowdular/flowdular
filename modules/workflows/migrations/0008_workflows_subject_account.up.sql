-- The person behind a run, resolved once at write time instead of read out of
-- the stored actor document on every erasure. A run started by a person names
-- them in its actor, a run started by a schedule, a webhook or an automation
-- names them in the service actor's configuredBy, and a run an agent started
-- names them in the delegated authorization subject; this column is that one
-- answer, and the three predicates it replaces become a single equality.
-- This supersedes the expression indexes of 0006 and 0007, which the erasure
-- cannot use: the jsonb extraction operator is not leakproof, so under the
-- forced row level security policy PostgreSQL applies the policy first and the
-- comparison can never become an index condition. A plain text column compares
-- leakproof and indexes normally, so the same query becomes an index scan on
-- the connection the erasure actually runs on. Both older indexes stay because
-- an applied migration is immutable; they are dead weight, not a hazard.
ALTER TABLE workflow_runs
  ADD COLUMN subject_account_id TEXT;
UPDATE workflow_runs
SET subject_account_id = COALESCE(
  actor_json::jsonb -> 'configuredBy' ->> 'id',
  authorization_subject_json::jsonb ->> 'id',
  actor_json::jsonb ->> 'id'
)
WHERE subject_account_id IS NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_subject_account_idx
  ON workflow_runs (tenant_id, subject_account_id, id);
