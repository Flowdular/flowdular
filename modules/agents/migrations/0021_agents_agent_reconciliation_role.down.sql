REVOKE SELECT (tenant_id) ON agent_definitions FROM coreloom_background;
DROP POLICY agent_definitions_reconciliation_policy ON agent_definitions;
REVOKE SELECT (tenant_id, agent_id) ON module_agent_bindings FROM coreloom_background;
DROP POLICY module_agent_bindings_reconciliation_policy ON module_agent_bindings;
