-- agents.definitions.list pages by lower(name) or updated_at, each followed by
-- id, and agent_definitions_tenant_name_idx orders by the raw name, so neither
-- paged read had an index carrying its order. agents.runs.list orders queued_at
-- and id in one direction, while agent_runs_tenant_queued_idx carries queued_at
-- descending beside an ascending id, so the planner sorted every page.
CREATE INDEX IF NOT EXISTS agent_definitions_tenant_name_key_idx
  ON agent_definitions (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS agent_definitions_tenant_updated_idx
  ON agent_definitions (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_queue_order_idx
  ON agent_runs (tenant_id, queued_at, id);
