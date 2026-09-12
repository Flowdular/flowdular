-- The narrowed check refuses rows already written under the metering kind, so
-- those rows go before it is restored. A subscription that selected it keeps
-- the entry in its JSON events: nothing publishes that kind after the rollback,
-- and the next edit of that subscription is refused until it is deselected.
DELETE FROM notifications_deliveries WHERE kind = 'meter-threshold';
DELETE FROM notifications_preferences WHERE kind = 'meter-threshold';
DELETE FROM notifications_inbox WHERE kind = 'meter-threshold';
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_kind_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_preferences DROP CONSTRAINT IF EXISTS notifications_preferences_kind_check;
ALTER TABLE notifications_preferences ADD CONSTRAINT notifications_preferences_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_inbox DROP CONSTRAINT IF EXISTS notifications_inbox_kind_check;
ALTER TABLE notifications_inbox ADD CONSTRAINT notifications_inbox_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
