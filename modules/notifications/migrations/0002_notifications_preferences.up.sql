CREATE TABLE IF NOT EXISTS notifications_preferences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  enabled SMALLINT NOT NULL CHECK (enabled IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- An absent row means enabled, so one row per member and kind is the whole rule.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_preferences_member_kind_idx
  ON notifications_preferences (tenant_id, recipient_account_id, kind);
ALTER TABLE notifications_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_preferences_tenant_policy ON notifications_preferences
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
