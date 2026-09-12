-- A subject erasure asks one workspace for the runs a person is behind, and
-- that is three questions rather than one: the runs the person started, the
-- runs a service actor they configured started, and the runs an agent started
-- on their behalf. 0006 indexed the first, which is the only one held in the
-- actor's own id. These give the other two the same support.
-- Neither is reachable from the connection the erasure runs on, and 0006's is
-- not either. The jsonb extraction operator is not leakproof, so under the
-- forced row level security policy PostgreSQL applies the policy first and the
-- comparison stays a filter rather than an index condition: measured over
-- 20000 runs, the runtime role scans the workspace while the migration role
-- uses the index. The batch limit is what bounds an erasure until the subject
-- account is stored in a column of its own, which compares leakproof and
-- indexes plainly; that column is the precise fix and it retires all three.
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_configured_by_idx
  ON workflow_runs (tenant_id, (actor_json::jsonb -> 'configuredBy' ->> 'id'), id);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_subject_idx
  ON workflow_runs (tenant_id, (authorization_subject_json::jsonb ->> 'id'), id);
