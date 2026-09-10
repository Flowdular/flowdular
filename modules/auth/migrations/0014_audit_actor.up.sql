ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (actor_kind IN ('user', 'agent'));
ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS actor_run_id TEXT
  CHECK (actor_run_id IS NULL OR length(actor_run_id) BETWEEN 1 AND 128);
