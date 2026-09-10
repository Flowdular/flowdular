CREATE TABLE IF NOT EXISTS agent_audit_events_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
INSERT INTO agent_audit_events_v2
  SELECT * FROM agent_audit_events ORDER BY tenant_id, sequence
ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS agent_audit_v2_tenant_time_idx
  ON agent_audit_events_v2 (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE agent_audit_events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_events_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_audit_events_v2_tenant_policy ON agent_audit_events_v2
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
