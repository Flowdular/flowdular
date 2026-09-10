CREATE TABLE IF NOT EXISTS agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (actor_json IS JSON OBJECT)
);
CREATE INDEX IF NOT EXISTS agent_run_actors_tenant_idx
  ON agent_run_actors (tenant_id, run_id);
INSERT INTO agent_run_actors (run_id, tenant_id, actor_json)
  SELECT id, tenant_id,
         jsonb_build_object('kind', 'user', 'id', requested_by, 'label', requested_by)::text
  FROM agent_runs
ON CONFLICT DO NOTHING;
ALTER TABLE agent_run_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_actors FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_actors_tenant_policy ON agent_run_actors
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
