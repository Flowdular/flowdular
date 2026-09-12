CREATE TABLE IF NOT EXISTS connectors_call_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 200),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  call_id TEXT,
  claimed_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS connectors_call_keys_tenant_claimed_idx
  ON connectors_call_keys (tenant_id, claimed_at, id);
ALTER TABLE connectors_call_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_call_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_call_keys_tenant_policy ON connectors_call_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
