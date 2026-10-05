-- Reversing this forgets every recorded heartbeat, so the worker status reads
-- not-seen until a worker drains again.
DROP POLICY IF EXISTS agent_worker_heartbeats_tenant_policy ON agent_worker_heartbeats;
DROP INDEX IF EXISTS agent_worker_heartbeats_time_idx;
DROP TABLE IF EXISTS agent_worker_heartbeats;
