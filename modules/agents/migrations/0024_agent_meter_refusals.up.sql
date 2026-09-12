-- A meter refusal stands until the workspace's month turns or its limit is
-- raised, so recording it on every refused enqueue wrote the same fact to the
-- hash-chained trail as fast as a caller could retry. This row is the claim
-- that the refusal has already been recorded: the first refusal of a workspace,
-- a meter and a month takes it and writes the audit event, and every refusal
-- behind it is answered without touching the trail.
--
-- One row per workspace and meter at a time. The claim removes the rows of
-- earlier months for that workspace and meter in the same transaction, so the
-- table is bounded by the meters agents.core declares rather than by time.
CREATE TABLE IF NOT EXISTS agent_meter_refusals (
  tenant_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  period TEXT NOT NULL,
  first_refused_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, meter, period)
);
ALTER TABLE agent_meter_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_meter_refusals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_meter_refusals_tenant_policy ON agent_meter_refusals
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
