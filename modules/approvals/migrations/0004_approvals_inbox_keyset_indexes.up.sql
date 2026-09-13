-- The inbox pages by keyset on (created_at, id) in one direction, under a
-- status filter, a requester filter, or neither. The two indexes 0001 carries
-- order created_at DESC with id ASC, so a page walked in either direction ends
-- in a sort, and a workspace-wide page has no index at all. These three carry
-- both keys ascending: a newest-first page is a backward scan of the same
-- index, and a page continued from a cursor starts where the cursor names.
CREATE INDEX IF NOT EXISTS approvals_requests_status_created_idx
  ON approvals_requests (tenant_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS approvals_requests_requester_created_idx
  ON approvals_requests (tenant_id, requester_account_id, created_at, id);
CREATE INDEX IF NOT EXISTS approvals_requests_created_idx
  ON approvals_requests (tenant_id, created_at, id);
