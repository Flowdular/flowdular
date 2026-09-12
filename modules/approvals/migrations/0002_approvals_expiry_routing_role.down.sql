REVOKE SELECT (tenant_id, id, expires_at, status) ON approvals_requests FROM coreloom_background;
DROP POLICY IF EXISTS approvals_requests_background_policy ON approvals_requests;
