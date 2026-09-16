-- One row per try of one adapter for one search or fetch, the adapters the
-- circuit breaker skipped included, kept for diagnosis whether the chain
-- answered or not. query_id is the query row of a search or the evidence id of
-- a fetch, and has no foreign key because a query that answered nothing is
-- released while its attempts stay.
CREATE TABLE IF NOT EXISTS research_attempts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  query_id TEXT NOT NULL CHECK (length(query_id) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('search', 'fetch')),
  adapter TEXT NOT NULL CHECK (adapter IN ('model-native', 'searxng', 'firecrawl', 'connector', 'recorded', 'direct')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 5),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'empty', 'retryable', 'permanent', 'skipped-circuit')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS research_attempts_tenant_query_idx
  ON research_attempts (tenant_id, query_id, created_at, id);
CREATE INDEX IF NOT EXISTS research_attempts_tenant_created_idx
  ON research_attempts (tenant_id, created_at, id);
ALTER TABLE research_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY research_attempts_tenant_policy ON research_attempts
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- The circuit breaker of one adapter in one workspace. open_until is set when
-- the consecutive failures reach the threshold, and moved forward by the one
-- query that takes the half open probe.
CREATE TABLE IF NOT EXISTS research_adapter_health (
  tenant_id TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('model-native', 'searxng', 'firecrawl', 'connector', 'recorded', 'direct')),
  consecutive_failures BIGINT NOT NULL CHECK (consecutive_failures >= 0),
  open_until BIGINT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  last_success_at BIGINT,
  PRIMARY KEY (tenant_id, adapter)
);
ALTER TABLE research_adapter_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_adapter_health FORCE ROW LEVEL SECURITY;
CREATE POLICY research_adapter_health_tenant_policy ON research_adapter_health
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A query row names the adapter that answered, and the chain adds two.
ALTER TABLE research_queries DROP CONSTRAINT IF EXISTS research_queries_adapter_check;
ALTER TABLE research_queries ADD CONSTRAINT research_queries_adapter_check
  CHECK (adapter IN ('model-native', 'searxng', 'firecrawl', 'connector', 'recorded'));
