CREATE TABLE IF NOT EXISTS notifications_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  source_module TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  attempt_number BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'dead-letter')),
  scheduled_for BIGINT NOT NULL,
  completed_at BIGINT,
  response_status BIGINT,
  error_class TEXT,
  payload_digest TEXT NOT NULL,
  payload_bytes BIGINT NOT NULL,
  occurred_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
-- One row per attempt. The sequence separates the original attempt run from the
-- ones a replay starts, so publishing the same event twice collides on attempt
-- one of sequence one while a replay still numbers its own attempts from one.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_deliveries_attempt_idx
  ON notifications_deliveries (tenant_id, subscription_id, kind, source_ref, sequence, attempt_number);
CREATE INDEX IF NOT EXISTS notifications_deliveries_routing_idx
  ON notifications_deliveries (status, scheduled_for, tenant_id, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_tenant_status_idx
  ON notifications_deliveries (tenant_id, status, scheduled_for DESC, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_retention_idx
  ON notifications_deliveries (tenant_id, completed_at);
ALTER TABLE notifications_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_deliveries_tenant_policy ON notifications_deliveries
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
