-- The workspace data class registry sweeps and exports what this module holds,
-- and both walks key off (tenant_id, created_at, id). Without these indexes the
-- inbox sweep would scan every row of a workspace on every bounded pass and the
-- export keyset would sort the whole table per page, so the cost of one pass
-- would grow with the history rather than with the batch.
--
-- created_at and id never change after a row is written, so a walk over them
-- cannot revisit or skip a row while the table is still being written to. The
-- deliveries ledger already carries (tenant_id, completed_at) for the delivery
-- loop's own retention pass; that key is mutable until an attempt completes and
-- serves the sweep only, so the export gets its own immutable one here.
CREATE INDEX IF NOT EXISTS notifications_inbox_retention_idx
  ON notifications_inbox (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_created_idx
  ON notifications_deliveries (tenant_id, created_at, id);
