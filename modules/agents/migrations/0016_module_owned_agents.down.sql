DROP TRIGGER IF EXISTS agent_revision_ownership_no_delete;
DROP TRIGGER IF EXISTS agent_revision_ownership_no_update;
DROP TABLE IF EXISTS agent_revision_ownership;
DROP INDEX IF EXISTS module_agent_bindings_tenant_status_idx;
DROP TABLE IF EXISTS module_agent_bindings;
DROP TABLE IF EXISTS module_agent_definitions;
