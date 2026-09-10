CREATE TABLE IF NOT EXISTS agent_run_costs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cost_micro_usd BIGINT,
  completed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_day_idx
  ON agent_run_costs (tenant_id, day);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_agent_idx
  ON agent_run_costs (tenant_id, agent_id, day);
INSERT INTO agent_run_costs
  (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
   output_tokens, cost_micro_usd, completed_at)
  SELECT id, tenant_id, agent_id, agent_name, model,
         to_char(to_timestamp(completed_at / 1000), 'YYYY-MM-DD'),
         COALESCE((usage_json::jsonb ->> 'inputTokens')::bigint, 0),
         COALESCE((usage_json::jsonb ->> 'outputTokens')::bigint, 0),
         NULL, completed_at
  FROM agent_runs
  WHERE status = 'succeeded' AND usage_json IS NOT NULL AND completed_at IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE agent_run_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_costs_tenant_policy ON agent_run_costs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
