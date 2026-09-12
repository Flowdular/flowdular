CREATE TABLE IF NOT EXISTS notifications_inbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  title TEXT NOT NULL,
  body TEXT,
  source_module TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'archived')),
  read_at TIMESTAMPTZ,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_inbox_tenant_recipient_account_id_idx
  ON notifications_inbox (tenant_id, recipient_account_id, id);
-- Publishing is idempotent on the source reference. The capability checks first,
-- but this index is what actually guarantees one item per member per event.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_inbox_source_idx
  ON notifications_inbox (tenant_id, recipient_account_id, kind, source_ref);
CREATE INDEX IF NOT EXISTS notifications_inbox_member_status_idx
  ON notifications_inbox (tenant_id, recipient_account_id, status, created_at DESC, id);
ALTER TABLE notifications_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_inbox_tenant_policy ON notifications_inbox
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
