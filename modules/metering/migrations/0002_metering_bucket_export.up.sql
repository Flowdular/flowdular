-- The data class export walks a workspace's buckets by id, ascending. The
-- retention index leads with the day, so it cannot serve that walk and a large
-- workspace paged through a sequential scan per page.
CREATE INDEX IF NOT EXISTS metering_buckets_tenant_export_idx
  ON metering_buckets (tenant_id, id);
