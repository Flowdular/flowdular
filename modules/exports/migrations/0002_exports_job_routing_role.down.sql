REVOKE SELECT (tenant_id, id, status, started_at)
  ON exports_jobs FROM coreloom_background;
DROP POLICY IF EXISTS exports_jobs_background_policy ON exports_jobs;
DROP INDEX IF EXISTS exports_jobs_routing_idx;
