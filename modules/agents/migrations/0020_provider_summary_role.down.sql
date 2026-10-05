REVOKE SELECT (id, enabled) ON agent_provider_connections FROM flowdular_background;
DROP POLICY IF EXISTS agent_provider_connections_background_policy ON agent_provider_connections;
