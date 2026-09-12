-- A claimed attempt has to return to the queue before the column goes, or the
-- rollback leaves rows in a state the old check constraint refuses.
UPDATE notifications_deliveries SET status = 'pending' WHERE status = 'sending';
REVOKE SELECT (claimed_at) ON notifications_deliveries FROM coreloom_background;
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_status_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed', 'dead-letter'));
ALTER TABLE notifications_deliveries DROP COLUMN IF EXISTS claimed_at;
