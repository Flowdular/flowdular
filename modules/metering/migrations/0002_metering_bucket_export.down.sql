-- Reverses 0002: the export walk falls back to a scan of the workspace's
-- buckets per page, which is correct but unindexed.
DROP INDEX IF EXISTS metering_buckets_tenant_export_idx;
