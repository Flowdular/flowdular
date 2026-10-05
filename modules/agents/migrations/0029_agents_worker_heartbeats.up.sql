-- Worker availability is read from durable evidence, so a web role answers the
-- same as the worker it asks about. A row names one worker process, when it
-- started, when it last drained and how many runs it may hold at once. It
-- carries nothing about a workspace and lives under this table's own sentinel
-- tenant, which the check pins.
CREATE TABLE IF NOT EXISTS agent_worker_heartbeats (
  tenant_id TEXT NOT NULL CHECK (tenant_id = '__flowdular_agent_workers__'),
  worker_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL,
  concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 16),
  PRIMARY KEY (tenant_id, worker_id)
);
CREATE INDEX IF NOT EXISTS agent_worker_heartbeats_time_idx
  ON agent_worker_heartbeats (tenant_id, heartbeat_at, worker_id);
ALTER TABLE agent_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_worker_heartbeats_tenant_policy ON agent_worker_heartbeats
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
