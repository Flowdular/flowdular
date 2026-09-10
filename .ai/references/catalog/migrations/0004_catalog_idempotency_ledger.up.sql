CREATE TABLE IF NOT EXISTS catalog_idempotency_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 160),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71),
  outcome TEXT NOT NULL CHECK (outcome = 'succeeded'),
  result_json TEXT NOT NULL CHECK (result_json::jsonb IS NOT NULL),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 71),
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS catalog_idempotency_ledger_tenant_operation_idx
  ON catalog_idempotency_ledger (tenant_id, operation_id, created_at, id);
ALTER TABLE catalog_idempotency_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_idempotency_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_idempotency_ledger_tenant_policy ON catalog_idempotency_ledger
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
