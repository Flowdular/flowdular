-- One row per recorded attestation: someone reviewed who held what for one
-- period, and these are the counts the server computed at that moment. The
-- table is append-only, so no statement in this module updates or deletes a
-- row and the index below serves the only read there is: newest first.
CREATE TABLE IF NOT EXISTS access_attestations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reviewer_account_id TEXT NOT NULL CHECK (length(reviewer_account_id) BETWEEN 1 AND 64),
  reviewer_label TEXT NOT NULL CHECK (length(reviewer_label) BETWEEN 1 AND 254),
  period_from TIMESTAMPTZ NOT NULL,
  period_to TIMESTAMPTZ NOT NULL,
  member_count BIGINT NOT NULL CHECK (member_count >= 0),
  active_member_count BIGINT NOT NULL CHECK (active_member_count >= 0),
  role_count BIGINT NOT NULL CHECK (role_count >= 0),
  extra_scope_count BIGINT NOT NULL CHECK (extra_scope_count >= 0),
  token_count BIGINT NOT NULL CHECK (token_count >= 0),
  provider_count BIGINT NOT NULL CHECK (provider_count >= 0),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at BIGINT NOT NULL,
  CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS access_attestations_tenant_created_idx
  ON access_attestations (tenant_id, created_at DESC, id DESC);
ALTER TABLE access_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY access_attestations_tenant_policy ON access_attestations
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
