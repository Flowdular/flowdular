-- The data class export walks a workspace oldest first by (started_at, id) and
-- the retention sweep picks its batch by the same key. The listing index orders
-- started_at descending, and reading it backwards pairs an ascending started_at
-- with a descending id, so neither walk can be served by it. The outcome and
-- mapping walks keep using the unique keys their tables already carry.
CREATE INDEX IF NOT EXISTS import_jobs_tenant_export_idx
  ON import_jobs (tenant_id, started_at, id);
