REVOKE SELECT (tenant_id, class_id, sweepable, retention_mode, retention_days, default_retention_days, last_swept_at) ON audit_data_classes FROM coreloom_background;
DROP POLICY IF EXISTS audit_data_classes_background_policy ON audit_data_classes;
