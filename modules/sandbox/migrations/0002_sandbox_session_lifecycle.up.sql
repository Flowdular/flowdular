-- Sessions gain an archive timestamp and two lifecycle states. SQLite cannot
-- widen a CHECK constraint in place, so the table is rebuilt; the repository
-- applies this only when archived_at is missing.
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ejected_at INTEGER,
  archived_at INTEGER
) STRICT;
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
