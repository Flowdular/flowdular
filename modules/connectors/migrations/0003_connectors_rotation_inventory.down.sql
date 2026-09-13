REVOKE SELECT (tenant_id, credential_key_id) ON connectors_instances FROM coreloom_background;
DROP POLICY IF EXISTS connectors_instances_background_policy ON connectors_instances;
