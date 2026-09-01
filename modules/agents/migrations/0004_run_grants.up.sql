CREATE TABLE IF NOT EXISTS agent_run_grant_uses (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_grant_expiry_idx
  ON agent_run_grant_uses (expires_at);
