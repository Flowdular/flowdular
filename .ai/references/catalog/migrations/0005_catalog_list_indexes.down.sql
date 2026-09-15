DROP INDEX IF EXISTS catalog_items_tenant_updated_idx;
DROP INDEX IF EXISTS catalog_items_tenant_name_idx;
ALTER TABLE catalog_items DROP COLUMN IF EXISTS updated_at;
