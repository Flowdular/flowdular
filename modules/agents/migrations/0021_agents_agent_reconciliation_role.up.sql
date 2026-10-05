-- Discover only tenant routing keys; boot-time writes still use tenant transactions.
CREATE POLICY agent_definitions_reconciliation_policy ON agent_definitions
  FOR SELECT TO flowdular_background USING (true);
GRANT SELECT (tenant_id) ON agent_definitions TO flowdular_background;
CREATE POLICY module_agent_bindings_reconciliation_policy ON module_agent_bindings
  FOR SELECT TO flowdular_background USING (true);
GRANT SELECT (tenant_id, agent_id) ON module_agent_bindings TO flowdular_background;
