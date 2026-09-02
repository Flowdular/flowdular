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
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  registered_at INTEGER NOT NULL,
  UNIQUE (module_id, agent_key)
) STRICT;

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
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
) STRICT;
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
) STRICT;
CREATE TRIGGER IF NOT EXISTS agent_revision_ownership_no_update
  BEFORE UPDATE ON agent_revision_ownership
  BEGIN SELECT RAISE(ABORT, 'agent revision ownership is immutable'); END;
CREATE TRIGGER IF NOT EXISTS agent_revision_ownership_no_delete
  BEFORE DELETE ON agent_revision_ownership
  BEGIN SELECT RAISE(ABORT, 'agent revision ownership is immutable'); END;
