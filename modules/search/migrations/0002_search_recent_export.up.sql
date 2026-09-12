-- The export walk pages on the immutable key. Re-running a query rewrites its
-- ran_at, so a keyset on the timestamp hands the walk the same row again; the
-- retention index orders by ran_at and cannot serve the id order.
CREATE INDEX IF NOT EXISTS search_recent_queries_export_idx
  ON search_recent_queries (tenant_id, id);
