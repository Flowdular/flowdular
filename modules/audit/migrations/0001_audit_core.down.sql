DROP POLICY IF EXISTS audit_events_tenant_policy ON audit_events;
DROP POLICY IF EXISTS audit_export_runs_tenant_policy ON audit_export_runs;
DROP POLICY IF EXISTS audit_sweep_runs_tenant_policy ON audit_sweep_runs;
DROP POLICY IF EXISTS audit_data_classes_tenant_policy ON audit_data_classes;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS audit_export_runs;
DROP TABLE IF EXISTS audit_sweep_runs;
DROP TABLE IF EXISTS audit_data_classes;
