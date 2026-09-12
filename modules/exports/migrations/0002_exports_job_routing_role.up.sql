-- The poll loop must find waiting jobs across workspaces before it knows whose
-- they are, so it reads the routing columns alone on the background role: the
-- list, the requester snapshot, the object and every count stay invisible to
-- it, and each job it picks is claimed and run again under the workspace the
-- routing row named. PostgreSQL checks column privileges in WHERE too, so
-- `status` is part of the grant. A job already running is routed as well, so a
-- claim whose process is gone is found again once its lease lapses.
CREATE INDEX IF NOT EXISTS exports_jobs_routing_idx
  ON exports_jobs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY exports_jobs_background_policy ON exports_jobs
  FOR SELECT TO coreloom_background
  USING (status IN ('requested', 'running'));
REVOKE SELECT ON exports_jobs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON exports_jobs TO coreloom_background;
