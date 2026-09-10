-- Sessions gain an archive timestamp and two lifecycle states. The table is
-- rebuilt rather than altered in place so the widened state constraint, the
-- new column, the index, and the tenant policy all land in one step.
CREATE TABLE sandbox_sessions_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  title TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  driver TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('loopback', 'self-hosted')),
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'classified', 'planned', 'editing', 'validating',
    'previewing', 'awaiting-approval', 'accepted', 'failed', 'blocked',
    'archived', 'deleted'
  )),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  ejected_at BIGINT,
  archived_at BIGINT
);
INSERT INTO sandbox_sessions_v2
  (id, tenant_id, account_id, module_id, title, blueprint, driver, mode, state,
   created_at, updated_at, ejected_at, archived_at)
  SELECT id, tenant_id, account_id, module_id, title, blueprint, driver, mode,
         state, created_at, updated_at, ejected_at, NULL
  FROM sandbox_sessions;
DROP TABLE sandbox_sessions;
ALTER TABLE sandbox_sessions_v2 RENAME TO sandbox_sessions;
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);
ALTER TABLE sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_sessions_tenant_policy ON sandbox_sessions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
