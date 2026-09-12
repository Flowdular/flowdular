-- Reverses 0002: the export walk falls back to a sequential scan of the
-- workspace's rows, which is correct but unindexed.
DROP INDEX IF EXISTS search_recent_queries_export_idx;
