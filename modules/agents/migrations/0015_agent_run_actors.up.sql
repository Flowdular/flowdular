CREATE TABLE IF NOT EXISTS agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object')
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_actors_tenant_idx
  ON agent_run_actors (tenant_id, run_id);
INSERT OR IGNORE INTO agent_run_actors (run_id, tenant_id, actor_json)
  SELECT id, tenant_id,
         json_object('kind', 'user', 'id', requested_by, 'label', requested_by)
  FROM agent_runs;
