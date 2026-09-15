ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
-- The backfill runs as the migrator, which forced row security keeps out of
-- every row without a tenant setting; lift the flag for the statement only.
ALTER TABLE catalog_items NO FORCE ROW LEVEL SECURITY;
UPDATE catalog_items SET updated_at = created_at WHERE updated_at = 0;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_items ALTER COLUMN updated_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS catalog_items_tenant_name_idx
  ON catalog_items (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS catalog_items_tenant_updated_idx
  ON catalog_items (tenant_id, updated_at, id);
