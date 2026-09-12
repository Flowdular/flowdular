-- The delivery loop must find due attempts across tenants, and retention must
-- find the tenants that still hold attempts at all. It is granted exactly the
-- four routing columns: the subscription, the source reference, the digest and
-- the ledger outcome stay invisible to it, and every attempt is read again under
-- the tenant the routing row named before any request leaves the process.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY notifications_deliveries_background_policy ON notifications_deliveries
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON notifications_deliveries FROM coreloom_background;
GRANT SELECT (tenant_id, id, scheduled_for, status) ON notifications_deliveries TO coreloom_background;
