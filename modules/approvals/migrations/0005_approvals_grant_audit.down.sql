-- The issuance ledger carries no data any other table depends on.
DROP POLICY IF EXISTS approvals_audit_tenant_policy ON approvals_audit;
DROP INDEX IF EXISTS approvals_audit_request_idx;
DROP TABLE IF EXISTS approvals_audit;
