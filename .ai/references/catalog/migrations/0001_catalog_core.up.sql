CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  sku_normalized TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  unit TEXT NOT NULL,
  base_price_minor BIGINT NOT NULL CHECK (base_price_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, sku_normalized)
);
CREATE INDEX IF NOT EXISTS catalog_items_tenant_sku_idx
  ON catalog_items (tenant_id, sku_normalized, id);
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_items_tenant_policy ON catalog_items
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
