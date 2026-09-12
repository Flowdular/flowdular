-- An export is a request the running platform answers. The operator command
-- records the row and waits; the platform process, the only one holding the
-- sealed data class registry with every owner port, performs the export and
-- records what it wrote. The request columns are what the operator asked for,
-- the result columns what the platform produced, and claimed_at is the lease
-- that keeps two platform processes from writing one archive twice.
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS output_directory TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS dry_run SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS workspace_slug TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS workspace_name TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS archive_path TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS summary_json TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_export_runs_dry_run_check') THEN
    ALTER TABLE audit_export_runs
      ADD CONSTRAINT audit_export_runs_dry_run_check CHECK (dry_run IN (0, 1));
  END IF;
END
$$;
-- The platform loop finds requested runs across workspaces before it knows
-- whose they are, so it reads the routing columns alone on the background
-- role; every run it picks is read again under the workspace the routing row
-- named before a single byte is written.
CREATE INDEX IF NOT EXISTS audit_export_runs_pending_idx
  ON audit_export_runs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_export_runs_background_policy ON audit_export_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_export_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON audit_export_runs TO coreloom_background;
