-- Sealing, legal hold and erasure on request. Three tables and four columns.
--
-- audit_anchors closes segments of the per-workspace event chain. An anchor
-- seals the sequence range, the row count, the time range, the hash chain over
-- the segment continuing from the anchor before it, and the hash of that anchor
-- itself; the signature is HMAC-SHA256 over the anchor hash, so re-signing
-- under a rotated key changes the signature and the key id alone and every
-- segment file already written still verifies.
CREATE TABLE IF NOT EXISTS audit_anchors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  anchor_sequence BIGINT NOT NULL CHECK (anchor_sequence > 0),
  from_sequence BIGINT NOT NULL CHECK (from_sequence > 0),
  to_sequence BIGINT NOT NULL,
  row_count BIGINT NOT NULL CHECK (row_count > 0),
  first_occurred_at BIGINT NOT NULL,
  last_occurred_at BIGINT NOT NULL,
  segment_hash TEXT NOT NULL,
  previous_anchor_hash TEXT,
  anchor_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  segment_file TEXT NOT NULL,
  sealed_by TEXT NOT NULL,
  sealed_at BIGINT NOT NULL,
  CHECK (to_sequence >= from_sequence),
  UNIQUE (tenant_id, anchor_sequence),
  UNIQUE (tenant_id, to_sequence),
  UNIQUE (tenant_id, anchor_hash)
);
-- The newest anchor of a workspace is read before every seal and before every
-- sweep of the event class, so it is the one lookup that has to stay O(1).
CREATE INDEX IF NOT EXISTS audit_anchors_tenant_sequence_idx
  ON audit_anchors (tenant_id, anchor_sequence DESC);
ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchors_tenant_policy ON audit_anchors
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A hold is a standing instruction not to remove what it covers. scope_kind
-- names the dimension it was placed on and the nullable columns narrow it
-- further, so an account hold limited to one class and one date range is one
-- row rather than three. A lifted hold is kept: who lifted it and why is the
-- evidence that the data became removable again.
CREATE TABLE IF NOT EXISTS audit_legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'workspace', 'data-class', 'date-range')),
  account_id TEXT,
  class_id TEXT,
  from_at BIGINT,
  to_at BIGINT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'lifted')),
  placed_by TEXT NOT NULL,
  placed_at BIGINT NOT NULL,
  lifted_by TEXT,
  lift_reason TEXT,
  lifted_at BIGINT,
  CHECK (scope_kind <> 'account' OR account_id IS NOT NULL),
  CHECK (scope_kind <> 'data-class' OR class_id IS NOT NULL),
  CHECK (scope_kind <> 'date-range' OR (from_at IS NOT NULL AND to_at IS NOT NULL)),
  CHECK (scope_kind <> 'workspace' OR (account_id IS NULL AND class_id IS NULL
         AND from_at IS NULL AND to_at IS NULL)),
  CHECK (from_at IS NULL OR to_at IS NULL OR to_at >= from_at),
  CHECK ((status = 'lifted') = (lifted_at IS NOT NULL))
);
-- The sweep and every erasure ask for the active holds of one workspace before
-- they touch a row, so that read walks an index instead of the table.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_status_idx
  ON audit_legal_holds (tenant_id, status, placed_at DESC, id);
ALTER TABLE audit_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_legal_holds_tenant_policy ON audit_legal_holds
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One data key per subject. Audit events are excluded from erasure because they
-- are the evidence the lifecycle happened, so the subject-identifying fields of
-- a new event are sealed under this key instead: destroying the key blanks the
-- material and the account it belonged to, and what is left is a tombstone that
-- proves an event existed and can never be read again. The row stays so the
-- events that point at it keep a target, and the chain hash covers the sealed
-- bytes rather than the plaintext, so destruction never breaks verification.
CREATE TABLE IF NOT EXISTS audit_subject_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT,
  material TEXT,
  sealed_at BIGINT NOT NULL,
  destroyed_at BIGINT,
  CHECK ((subject IS NULL) = (material IS NULL)),
  CHECK ((destroyed_at IS NULL) = (material IS NOT NULL))
);
-- Partial, because every destroyed key carries a null subject and two of them
-- would collide under a total unique index.
CREATE UNIQUE INDEX IF NOT EXISTS audit_subject_keys_tenant_subject_idx
  ON audit_subject_keys (tenant_id, subject)
  WHERE subject IS NOT NULL;
ALTER TABLE audit_subject_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_subject_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_subject_keys_tenant_policy ON audit_subject_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- An erasure is a request the running platform answers, for the same reason an
-- export is: only the platform process holds the registrations every owning
-- module made, so only it can reach an erase operation. The operator command
-- records the row and waits. The subject is kept while the run needs it and
-- blanked when it finishes, so the history proves an erasure happened without
-- naming the person it erased; subject_marker is the same hash the certificate
-- file is named after, which is what ties the two together.
CREATE TABLE IF NOT EXISTS audit_erasure_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT,
  subject_marker TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'completed', 'failed')),
  dry_run SMALLINT NOT NULL CHECK (dry_run IN (0, 1)),
  destroy_key SMALLINT NOT NULL CHECK (destroy_key IN (0, 1)),
  requested_by TEXT NOT NULL,
  output_directory TEXT,
  workspace_slug TEXT,
  workspace_name TEXT,
  classes BIGINT NOT NULL CHECK (classes >= 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  certificate_path TEXT,
  outcome_json TEXT,
  reason TEXT,
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_tenant_time_idx
  ON audit_erasure_runs (tenant_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_pending_idx
  ON audit_erasure_runs (status, started_at, tenant_id, id);
ALTER TABLE audit_erasure_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_erasure_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_erasure_runs_tenant_policy ON audit_erasure_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A sealed event keeps its actor and subject columns at a fixed marker and
-- carries the envelope beside them. The event hash reads the envelope in the
-- place the metadata used to sit, so the hash of a sealed row is a function of
-- the stored bytes alone and stays verifiable after the key is destroyed.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS subject_key_id TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS sealed_payload TEXT;
ALTER TABLE audit_sweep_runs ADD COLUMN IF NOT EXISTS held_back BIGINT;
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_subject_type_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_subject_type_check') THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_subject_type_check
      CHECK (subject_type IN ('data-class', 'sweep-run', 'export-run', 'legal-hold', 'erasure', 'chain-anchor'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_sealed_check') THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_sealed_check
      CHECK ((subject_key_id IS NULL) = (sealed_payload IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_sweep_runs_held_back_check') THEN
    ALTER TABLE audit_sweep_runs
      ADD CONSTRAINT audit_sweep_runs_held_back_check
      CHECK (held_back IS NULL OR held_back >= 0);
  END IF;
END
$$;
-- The anchor rotation counts anchors per key across every workspace before it
-- knows whose they are, so it reads the routing columns alone on the background
-- role; every anchor it names is read and re-signed under the workspace the
-- routing row named. The hashes stay invisible to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_anchors_background_policy ON audit_anchors
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_anchors FROM coreloom_background;
GRANT SELECT (tenant_id, id, key_id) ON audit_anchors TO coreloom_background;
CREATE POLICY audit_erasure_runs_background_policy ON audit_erasure_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_erasure_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON audit_erasure_runs TO coreloom_background;
