-- The workspace whose principals change platform-scoped settings. It is
-- deployment configuration rather than workspace data: at most one row, written
-- with the first workspace of an empty database, once by the single-workspace
-- rule for a deployment that predates it, and replaced by the operator command.
CREATE TABLE IF NOT EXISTS auth_operator_workspace (
  tenant_id TEXT PRIMARY KEY REFERENCES auth_tenants(id),
  source TEXT NOT NULL
    CHECK (source IN ('first-workspace', 'single-workspace', 'command')),
  recorded_at BIGINT NOT NULL
);
-- Every row indexes the same constant, so a second row is refused and two
-- processes recording at once land one.
CREATE UNIQUE INDEX IF NOT EXISTS auth_operator_workspace_one_row_idx
  ON auth_operator_workspace ((true));
-- The row is bound to the workspace it names, the way a workspace row is its
-- own tenant: a transaction bound to a workspace sees the row only when that
-- workspace is the operator, and writes only a row naming itself.
ALTER TABLE auth_operator_workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_operator_workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_operator_workspace_tenant_policy ON auth_operator_workspace
  USING (tenant_id = current_setting('flowdular.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('flowdular.tenant_id', true));
-- Whether another workspace is the operator is answered on the background
-- role, which reads the workspace id and nothing else and writes nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowdular_background') THEN
    RAISE EXCEPTION 'The flowdular_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY auth_operator_workspace_background_policy ON auth_operator_workspace
  FOR SELECT TO flowdular_background
  USING (true);
REVOKE ALL ON auth_operator_workspace FROM flowdular_background;
GRANT SELECT (tenant_id) ON auth_operator_workspace TO flowdular_background;
