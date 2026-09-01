CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  sku_normalized TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  unit TEXT NOT NULL,
  base_price_minor INTEGER NOT NULL CHECK (base_price_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, sku_normalized)
) STRICT;
CREATE INDEX IF NOT EXISTS catalog_items_tenant_sku_idx
  ON catalog_items (tenant_id, sku_normalized, id);
