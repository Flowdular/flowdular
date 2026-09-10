CREATE TABLE IF NOT EXISTS sandbox_access_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  note TEXT,
  granted_by TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  revoked_by TEXT,
  UNIQUE (tenant_id, account_id)
);
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
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  ejected_at BIGINT
);
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS sandbox_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('grant', 'session', 'module')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE INDEX IF NOT EXISTS sandbox_audit_tenant_time_idx
  ON sandbox_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE sandbox_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_access_grants_tenant_policy ON sandbox_access_grants
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_sessions_tenant_policy ON sandbox_sessions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE sandbox_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_audit_events_tenant_policy ON sandbox_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
