CREATE TABLE IF NOT EXISTS parties_idempotency_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 160),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71),
  outcome TEXT NOT NULL CHECK (outcome = 'succeeded'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 71),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS parties_idempotency_ledger_tenant_operation_idx
  ON parties_idempotency_ledger (tenant_id, operation_id, created_at, id);
