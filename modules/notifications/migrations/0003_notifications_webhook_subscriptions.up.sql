CREATE TABLE IF NOT EXISTS notifications_webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_fingerprint TEXT NOT NULL,
  secret_revision BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
  description TEXT,
  last_delivery_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);
-- The name is compared normalized, so the index has to normalize too or a
-- duplicate would only be caught by the service it is meant to back up.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_webhook_subscriptions_name_idx
  ON notifications_webhook_subscriptions (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS notifications_webhook_subscriptions_status_idx
  ON notifications_webhook_subscriptions (tenant_id, status, lower(name), id);
ALTER TABLE notifications_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_webhook_subscriptions_tenant_policy ON notifications_webhook_subscriptions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
