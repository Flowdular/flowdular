export const SANDBOX_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS sandbox_access_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  note TEXT,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  UNIQUE (tenant_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS sandbox_grants_tenant_idx
  ON sandbox_access_grants (tenant_id, revoked_at, email);

CREATE TABLE IF NOT EXISTS sandbox_sessions (
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
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS sandbox_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('grant', 'session', 'module')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS sandbox_audit_tenant_time_idx
  ON sandbox_audit_events (tenant_id, occurred_at DESC, sequence DESC);
`;

/* Applied by the repository only when sandbox_sessions has no archived_at
   column, because SQLite cannot widen a CHECK constraint in place. */
export const SANDBOX_MIGRATION_002 = `
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
`;
