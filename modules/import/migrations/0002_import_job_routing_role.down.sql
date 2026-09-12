REVOKE SELECT (tenant_id, id, status, started_at)
  ON import_jobs FROM coreloom_background;
DROP POLICY IF EXISTS import_jobs_background_policy ON import_jobs;
DROP INDEX IF EXISTS import_jobs_routing_idx;
