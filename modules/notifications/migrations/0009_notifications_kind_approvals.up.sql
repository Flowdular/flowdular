-- approvals.core publishes two kinds, so the closed set the inbox, the
-- preferences and the ledger all key off gains approval-requested and
-- approval-decided. Each check was written inline with its column, so it
-- carries the name PostgreSQL derived from it and is replaced under that name.
-- Widening a check reads no row and rewrites none.
--
-- A subscription's selected events are JSON text with no check behind them, so
-- an older subscription keeps exactly the kinds it was saved with and the
-- service is the only thing that decides which ones may be selected next.
ALTER TABLE notifications_inbox DROP CONSTRAINT IF EXISTS notifications_inbox_kind_check;
ALTER TABLE notifications_inbox ADD CONSTRAINT notifications_inbox_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_preferences DROP CONSTRAINT IF EXISTS notifications_preferences_kind_check;
ALTER TABLE notifications_preferences ADD CONSTRAINT notifications_preferences_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_kind_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
