-- A member asks for e-mail once, for the whole workspace, rather than per kind:
-- the per-kind switch already decides whether an inbox item exists at all, and
-- this decides whether the item that exists is also mailed. An absent row is
-- the default, e-mail off, so a member who never opened the screen is never
-- mailed by an upgrade.
CREATE TABLE IF NOT EXISTS notifications_member_preferences (
  tenant_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  email_delivery SMALLINT NOT NULL CHECK (email_delivery IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, recipient_account_id)
);
ALTER TABLE notifications_member_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_member_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_member_preferences_tenant_policy ON notifications_member_preferences
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- The queue carries two channels now. A webhook attempt is addressed to a
-- subscription of the workspace, an e-mail attempt to one member, and the
-- constraint keeps a row from claiming both or neither. Every existing row is a
-- webhook, which is why the column defaults to it.
ALTER TABLE notifications_deliveries ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'webhook';
ALTER TABLE notifications_deliveries ADD COLUMN IF NOT EXISTS recipient_account_id TEXT;
ALTER TABLE notifications_deliveries ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_channel_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_channel_check
  CHECK (
    (channel = 'webhook' AND subscription_id IS NOT NULL AND recipient_account_id IS NULL)
    OR (channel = 'email' AND recipient_account_id IS NOT NULL AND subscription_id IS NULL)
  );
-- One row per attempt, per target. The target is the subscription on a webhook
-- and the member on an e-mail, so the two channels of one event never collide
-- and publishing the same event twice still collides with itself.
DROP INDEX IF EXISTS notifications_deliveries_attempt_idx;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_deliveries_attempt_idx
  ON notifications_deliveries (tenant_id, channel, coalesce(subscription_id, recipient_account_id), kind, source_ref, sequence, attempt_number);
