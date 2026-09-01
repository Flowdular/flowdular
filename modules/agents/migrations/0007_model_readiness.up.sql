CREATE TABLE IF NOT EXISTS agent_provider_model_readiness (
  provider_id TEXT NOT NULL REFERENCES agent_provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  latency_ms INTEGER,
  error_code TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT;
INSERT OR IGNORE INTO agent_provider_model_readiness
  (provider_id, model_id, status, latency_ms, error_code, checked_at)
  SELECT id, readiness_model, readiness_status, readiness_latency_ms,
         readiness_error_code, readiness_checked_at
  FROM agent_provider_connections
  WHERE readiness_model IS NOT NULL
    AND readiness_checked_at IS NOT NULL
    AND readiness_status IN ('healthy', 'unhealthy');
