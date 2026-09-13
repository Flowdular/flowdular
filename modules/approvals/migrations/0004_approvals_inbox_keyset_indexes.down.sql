-- The three indexes carry no data of their own, so dropping them returns the
-- schema to what 0003 left and costs only the sort every inbox page then pays.
DROP INDEX IF EXISTS approvals_requests_created_idx;
DROP INDEX IF EXISTS approvals_requests_requester_created_idx;
DROP INDEX IF EXISTS approvals_requests_status_created_idx;
