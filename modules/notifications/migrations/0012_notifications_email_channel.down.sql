-- An e-mail attempt has no subscription to fall back to, so the rollback drops
-- those rows rather than leaving the queue holding attempts the webhook loop
-- cannot address. The member preferences go with the table that held them.
DELETE FROM notifications_deliveries WHERE channel = 'email';
DROP INDEX IF EXISTS notifications_deliveries_attempt_idx;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_deliveries_attempt_idx
  ON notifications_deliveries (tenant_id, subscription_id, kind, source_ref, sequence, attempt_number);
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_channel_check;
ALTER TABLE notifications_deliveries ALTER COLUMN subscription_id SET NOT NULL;
ALTER TABLE notifications_deliveries DROP COLUMN IF EXISTS recipient_account_id;
ALTER TABLE notifications_deliveries DROP COLUMN IF EXISTS channel;
DROP TABLE IF EXISTS notifications_member_preferences;
