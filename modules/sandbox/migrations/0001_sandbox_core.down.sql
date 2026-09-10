DROP POLICY IF EXISTS sandbox_access_grants_tenant_policy ON sandbox_access_grants;
DROP POLICY IF EXISTS sandbox_sessions_tenant_policy ON sandbox_sessions;
DROP POLICY IF EXISTS sandbox_audit_events_tenant_policy ON sandbox_audit_events;
DROP TABLE IF EXISTS sandbox_audit_events;
DROP TABLE IF EXISTS sandbox_sessions;
DROP TABLE IF EXISTS sandbox_access_grants;
