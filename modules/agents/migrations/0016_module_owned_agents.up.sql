-- SQLite expresses immutability with a BEFORE trigger that aborts. PostgreSQL
-- needs a function to raise from, shared by every immutable table here.
CREATE OR REPLACE FUNCTION coreloom_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS module_agent_definitions (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id),
  module_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 32),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  registered_at BIGINT NOT NULL,
  UNIQUE (module_id, agent_key)
);

CREATE TABLE IF NOT EXISTS module_agent_bindings (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES module_agent_definitions(agent_id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled_tools_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  module_definition_revision INTEGER NOT NULL CHECK (module_definition_revision >= 1),
  executable_revision INTEGER NOT NULL CHECK (executable_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
CREATE INDEX IF NOT EXISTS module_agent_bindings_tenant_status_idx
  ON module_agent_bindings (tenant_id, status, agent_id);

CREATE TABLE IF NOT EXISTS agent_revision_ownership (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  module_definition_revision INTEGER NOT NULL CHECK (module_definition_revision >= 1),
  PRIMARY KEY (tenant_id, agent_id, revision),
  FOREIGN KEY (tenant_id, agent_id, revision)
    REFERENCES agent_definition_revisions (tenant_id, agent_id, revision)
);
CREATE TRIGGER agent_revision_ownership_no_update
  BEFORE UPDATE ON agent_revision_ownership
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent revision ownership is immutable');
CREATE TRIGGER agent_revision_ownership_no_delete
  BEFORE DELETE ON agent_revision_ownership
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent revision ownership is immutable');
ALTER TABLE module_agent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_agent_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY module_agent_bindings_tenant_policy ON module_agent_bindings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_revision_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revision_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_revision_ownership_tenant_policy ON agent_revision_ownership
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
