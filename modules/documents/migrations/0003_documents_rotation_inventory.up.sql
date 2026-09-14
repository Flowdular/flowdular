-- The storage key rotation has to find the workspaces that still hold objects
-- before it knows which objects those are, so the cross-tenant role may count
-- stored rows by workspace and nothing else: the storage key, the record and
-- the file name stay invisible to it, and every object it names is read again
-- under the workspace that row named. PostgreSQL checks column privileges in
-- WHERE too, so `status` is part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY documents_files_background_policy ON documents_files
  FOR SELECT TO coreloom_background
  USING (status = 'stored');
REVOKE SELECT ON documents_files FROM coreloom_background;
GRANT SELECT (tenant_id, status) ON documents_files TO coreloom_background;
