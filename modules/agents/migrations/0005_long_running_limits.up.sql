CREATE TABLE IF NOT EXISTS agent_definition_execution_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
) STRICT;
INSERT OR IGNORE INTO agent_definition_execution_limits (agent_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_definitions;
CREATE TABLE IF NOT EXISTS agent_run_execution_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
) STRICT;
INSERT OR IGNORE INTO agent_run_execution_limits (run_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_runs;
