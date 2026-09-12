-- Both indexes carry no data of their own, so dropping them loses nothing; the
-- sweep and the export stay correct and become proportional to the history
-- instead of the batch.
DROP INDEX IF EXISTS notifications_deliveries_created_idx;
DROP INDEX IF EXISTS notifications_inbox_retention_idx;
