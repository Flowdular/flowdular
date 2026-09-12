-- The three indexes carry no data of their own, so dropping them returns the
-- schema to what 0002 left and costs only the scans the retention operations
-- then have to perform.
DROP INDEX IF EXISTS approvals_decisions_decider_account_idx;
DROP INDEX IF EXISTS approvals_requests_export_idx;
DROP INDEX IF EXISTS approvals_requests_resolved_idx;
