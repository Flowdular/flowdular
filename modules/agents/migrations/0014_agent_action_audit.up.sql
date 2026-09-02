CREATE TABLE IF NOT EXISTS agent_audit_events_v4 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
INSERT OR IGNORE INTO agent_audit_events_v4
  SELECT * FROM agent_audit_events_v3 ORDER BY tenant_id, sequence;
CREATE INDEX IF NOT EXISTS agent_audit_v4_tenant_time_idx
  ON agent_audit_events_v4 (tenant_id, occurred_at DESC, sequence DESC);
