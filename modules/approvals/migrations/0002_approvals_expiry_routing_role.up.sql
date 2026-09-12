-- The expiry loop has to find due pending requests before it knows whose they
-- are, and the requests table is invisible to the cross-tenant role: it carries
-- no background policy and the role holds no default table grant. This adds the
-- four routing columns and nothing else. The subject, the requester, the
-- requirement, the eligibility snapshot and the title stay unreadable on this
-- connection, and every request it names is read again under its own tenant
-- before anything about it is written.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY approvals_requests_background_policy ON approvals_requests
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON approvals_requests FROM coreloom_background;
GRANT SELECT (tenant_id, id, expires_at, status) ON approvals_requests TO coreloom_background;
