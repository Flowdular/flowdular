CREATE TABLE IF NOT EXISTS approvals_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_module TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  requester_account_id TEXT NOT NULL,
  requirement_json TEXT NOT NULL,
  decisions_needed BIGINT NOT NULL CHECK (decisions_needed >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  expires_at BIGINT NOT NULL,
  resolved_at BIGINT,
  created_at BIGINT NOT NULL
);
-- A subject module that reopens after a crash has to find the request it
-- already opened instead of asking the same question twice. One pending
-- request per subject reference is what makes opening idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_requests_pending_subject_idx
  ON approvals_requests (tenant_id, subject_module, subject_ref)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_requests_tenant_status_idx
  ON approvals_requests (tenant_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS approvals_requests_requester_idx
  ON approvals_requests (tenant_id, requester_account_id, created_at DESC, id);
-- The cross-tenant expiry poll reads in this order and stops at the first
-- request that is not due yet.
CREATE INDEX IF NOT EXISTS approvals_requests_routing_idx
  ON approvals_requests (status, expires_at, tenant_id, id);
ALTER TABLE approvals_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_requests_tenant_policy ON approvals_requests
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The eligibility snapshot taken when the request opened. It decides whose
-- inbox the request appears in, so it is a row per decider with its own index
-- rather than a list inside the request: the screen asks "what may I decide"
-- once per open workspace and that question has to stay one index lookup.
CREATE TABLE IF NOT EXISTS approvals_eligible (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id, account_id)
);
CREATE INDEX IF NOT EXISTS approvals_eligible_account_idx
  ON approvals_eligible (tenant_id, account_id, request_id);
ALTER TABLE approvals_eligible ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_eligible FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_eligible_tenant_policy ON approvals_eligible
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS approvals_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  decider_account_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'expire', 'cancel')),
  comment TEXT,
  decided_at BIGINT NOT NULL,
  -- Expiry is the one decision no member makes. Every other row names the
  -- account answerable for it, and the pair is checked here rather than only
  -- in the service that writes it.
  CHECK ((decision = 'expire') = (decider_account_id IS NULL))
);
-- One approval or rejection per member per request. The service checks first,
-- but this index is what actually guarantees the conflict it reports.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_decisions_decider_idx
  ON approvals_decisions (tenant_id, request_id, decider_account_id)
  WHERE decision IN ('approve', 'reject');
CREATE INDEX IF NOT EXISTS approvals_decisions_request_idx
  ON approvals_decisions (tenant_id, request_id, decided_at, id);
ALTER TABLE approvals_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_decisions_tenant_policy ON approvals_decisions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
