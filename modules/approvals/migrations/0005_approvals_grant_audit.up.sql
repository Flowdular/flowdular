-- The grant an approved request yields is derived from the row and the key on
-- every read, so nothing about the token itself is stored. What is stored is
-- the fact of its issuance: one row per resolved request whose subject names
-- a capability, with the capability, the input digest, the key that signs and
-- the moment the grant stops verifying, written in the deciding transaction.
CREATE TABLE IF NOT EXISTS approvals_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_audit_request_idx
  ON approvals_audit (tenant_id, request_id, occurred_at, id);
ALTER TABLE approvals_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_audit_tenant_policy ON approvals_audit
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
