CREATE TABLE IF NOT EXISTS parties_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS parties_history_tenant_record_version_idx
  ON parties_history (tenant_id, record_id, version DESC);
