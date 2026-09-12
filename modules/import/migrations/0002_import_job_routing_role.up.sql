-- The poll loop must find queued jobs across workspaces before it knows whose
-- they are, so it reads the routing columns alone on the background role: the
-- document, the target, the mapping, the requester and every row outcome stay
-- invisible to it, and each job it picks is claimed and processed again under
-- the workspace the routing row named. PostgreSQL checks column privileges in
-- WHERE too, so `status` is part of the grant.
CREATE INDEX IF NOT EXISTS import_jobs_routing_idx
  ON import_jobs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY import_jobs_background_policy ON import_jobs
  FOR SELECT TO coreloom_background
  USING (status IN ('parsing', 'writing'));
REVOKE SELECT ON import_jobs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON import_jobs TO coreloom_background;
