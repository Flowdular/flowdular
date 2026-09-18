-- The workspace assistant is a conversation of ordinary runs. A thread belongs
-- to one workspace and to the member who started it; only that member reads,
-- continues, renames or deletes it, so every statement carries the account
-- beside the tenant.
--
-- A turn keeps its question and its answer as its own text beside the run id
-- and holds no foreign key to agent_runs, so a thread still reads once run
-- retention has swept the runs that answered it.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_threads_member_idx
  ON assistant_threads (tenant_id, account_id, updated_at DESC, id DESC);
ALTER TABLE assistant_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_threads_tenant_policy ON assistant_threads
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS assistant_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  question TEXT NOT NULL,
  answer TEXT,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed')),
  failure_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (thread_id, sequence)
);
CREATE INDEX IF NOT EXISTS assistant_turns_thread_idx
  ON assistant_turns (tenant_id, thread_id, sequence);
-- The worker writes a settled run onto its turn by the run, once per turn, so
-- without this the write scans every turn the workspace holds.
CREATE INDEX IF NOT EXISTS assistant_turns_run_idx
  ON assistant_turns (tenant_id, run_id);
ALTER TABLE assistant_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_turns_tenant_policy ON assistant_turns
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A thread is a subject of this module's own hash-chained trail, so the reader
-- of an assistant action finds it beside the run it queued. Widening the check
-- keeps every stored event and its hash exactly as written.
ALTER TABLE agent_audit_events_v4
  DROP CONSTRAINT IF EXISTS agent_audit_events_v4_subject_type_check;
ALTER TABLE agent_audit_events_v4
  ADD CONSTRAINT agent_audit_events_v4_subject_type_check
  CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action', 'assistant-thread'));
