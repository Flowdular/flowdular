CREATE TABLE IF NOT EXISTS agent_definition_output_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_run_output_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
