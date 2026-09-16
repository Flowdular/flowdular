-- Evidence is what a search kept or a fetch read, as it was retrieved: the
-- sha256 and a bounded excerpt always, the full text only while the workspace
-- setting asks for it. Links attach evidence to a record another module owns,
-- and the owner module research.core ties result evidence to its query.
CREATE TABLE IF NOT EXISTS research_evidence (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  title TEXT NOT NULL CHECK (length(title) <= 300),
  excerpt TEXT NOT NULL CHECK (octet_length(excerpt) <= 4096),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  retrieved_at BIGINT NOT NULL,
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  document_id TEXT CHECK (document_id IS NULL OR length(document_id) BETWEEN 1 AND 128),
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 128),
  full_text TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS research_evidence_tenant_retrieved_idx
  ON research_evidence (tenant_id, retrieved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS research_evidence_tenant_created_by_idx
  ON research_evidence (tenant_id, created_by)
  WHERE created_by IS NOT NULL;
ALTER TABLE research_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY research_evidence_tenant_policy ON research_evidence
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS research_evidence_links (
  tenant_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  owner_module TEXT NOT NULL CHECK (length(owner_module) BETWEEN 3 AND 64),
  record_ref TEXT NOT NULL CHECK (length(record_ref) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, evidence_id, owner_module, record_ref),
  FOREIGN KEY (tenant_id, evidence_id)
    REFERENCES research_evidence (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS research_evidence_links_record_idx
  ON research_evidence_links (tenant_id, owner_module, record_ref);
ALTER TABLE research_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_evidence_links FORCE ROW LEVEL SECURITY;
CREATE POLICY research_evidence_links_tenant_policy ON research_evidence_links
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A cache of fetched text keyed by URL, read instead of the network until it
-- expires one day after the fetch.
CREATE TABLE IF NOT EXISTS research_pages (
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  title TEXT NOT NULL CHECK (length(title) <= 300),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  text TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, url)
);
CREATE INDEX IF NOT EXISTS research_pages_tenant_fetched_idx
  ON research_pages (tenant_id, fetched_at);
ALTER TABLE research_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY research_pages_tenant_policy ON research_pages
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One row per counted search. The monthly budget is the sum of cost_units
-- since the first instant of the UTC month, read under a per-workspace lock.
CREATE TABLE IF NOT EXISTS research_queries (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 400),
  adapter TEXT NOT NULL CHECK (adapter IN ('model-native', 'connector', 'recorded')),
  caller TEXT NOT NULL CHECK (caller IN ('agent', 'workflow', 'member')),
  caller_ref TEXT CHECK (caller_ref IS NULL OR length(caller_ref) BETWEEN 1 AND 200),
  result_count BIGINT NOT NULL CHECK (result_count >= 0),
  cost_units BIGINT NOT NULL CHECK (cost_units >= 0),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS research_queries_tenant_created_idx
  ON research_queries (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS research_queries_tenant_caller_ref_idx
  ON research_queries (tenant_id, caller_ref, created_at DESC)
  WHERE caller_ref IS NOT NULL;
ALTER TABLE research_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_queries FORCE ROW LEVEL SECURITY;
CREATE POLICY research_queries_tenant_policy ON research_queries
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS research_run_counters (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  fetches BIGINT NOT NULL CHECK (fetches >= 0),
  queries BIGINT NOT NULL CHECK (queries >= 0),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS research_run_counters_tenant_updated_idx
  ON research_run_counters (tenant_id, updated_at);
ALTER TABLE research_run_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_run_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY research_run_counters_tenant_policy ON research_run_counters
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
