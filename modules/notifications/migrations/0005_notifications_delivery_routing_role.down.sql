DROP POLICY IF EXISTS notifications_deliveries_background_policy ON notifications_deliveries;
REVOKE SELECT (tenant_id, id, scheduled_for, status) ON notifications_deliveries FROM coreloom_background;
