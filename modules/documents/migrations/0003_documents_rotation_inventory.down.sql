REVOKE SELECT (tenant_id, status) ON documents_files FROM coreloom_background;
DROP POLICY IF EXISTS documents_files_background_policy ON documents_files;
