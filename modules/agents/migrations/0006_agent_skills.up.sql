CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  required_tools_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, skill_key),
  UNIQUE (id, tenant_id)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_skills_tenant_name_idx ON agent_skills (tenant_id, name, id);
CREATE TABLE IF NOT EXISTS agent_skill_assignments (
  agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_id),
  FOREIGN KEY (skill_id, tenant_id) REFERENCES agent_skills(id, tenant_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS agent_run_skill_snapshots (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_revision INTEGER NOT NULL,
  required_tools_json TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_id)
) STRICT;
