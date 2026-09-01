CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS parties_tenant_name_idx
  ON parties (tenant_id, name, id);
