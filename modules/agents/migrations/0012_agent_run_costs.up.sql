CREATE TABLE IF NOT EXISTS agent_run_costs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER,
  completed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_day_idx
  ON agent_run_costs (tenant_id, day);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_agent_idx
  ON agent_run_costs (tenant_id, agent_id, day);
INSERT OR IGNORE INTO agent_run_costs
  (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
   output_tokens, cost_micro_usd, completed_at)
  SELECT id, tenant_id, agent_id, agent_name, model,
         strftime('%Y-%m-%d', completed_at / 1000, 'unixepoch'),
         CAST(COALESCE(json_extract(usage_json, '$.inputTokens'), 0) AS INTEGER),
         CAST(COALESCE(json_extract(usage_json, '$.outputTokens'), 0) AS INTEGER),
         NULL, completed_at
  FROM agent_runs
  WHERE status = 'succeeded' AND usage_json IS NOT NULL AND completed_at IS NOT NULL;
