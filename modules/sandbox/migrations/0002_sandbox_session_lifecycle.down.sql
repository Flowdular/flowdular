-- Drops archived and deleted sessions with the column; rows in those states
-- have no representation in the previous schema.
CREATE TABLE sandbox_sessions_v1 (
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
    'previewing', 'awaiting-approval', 'accepted', 'failed', 'blocked'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ejected_at INTEGER
) STRICT;
INSERT INTO sandbox_sessions_v1
  (id, tenant_id, account_id, module_id, title, blueprint, driver, mode, state,
   created_at, updated_at, ejected_at)
  SELECT id, tenant_id, account_id, module_id, title, blueprint, driver, mode,
         state, created_at, updated_at, ejected_at
  FROM sandbox_sessions
  WHERE state NOT IN ('archived', 'deleted');
DROP TABLE sandbox_sessions;
ALTER TABLE sandbox_sessions_v1 RENAME TO sandbox_sessions;
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);
