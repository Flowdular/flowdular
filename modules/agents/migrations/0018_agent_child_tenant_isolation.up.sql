-- These tables hang off a tenant-owned parent and were protected only by it.
-- A read by a caller-supplied parent id therefore crossed tenants with nothing
-- but application code in the way. Each one now carries its own tenant and the
-- same forced row security every other tenant table has, so a mistake in a
-- query cannot reach another workspace.
ALTER TABLE agent_definition_execution_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_definition_execution_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_definitions AS parent
WHERE parent.id = child.agent_id AND child.tenant_id IS NULL;
DELETE FROM agent_definition_execution_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_definition_execution_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_definition_execution_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_execution_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_execution_limits_tenant_policy
  ON agent_definition_execution_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_definition_output_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_definition_output_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_definitions AS parent
WHERE parent.id = child.agent_id AND child.tenant_id IS NULL;
DELETE FROM agent_definition_output_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_definition_output_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_definition_output_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_output_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_output_limits_tenant_policy
  ON agent_definition_output_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_execution_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_run_execution_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_execution_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_run_execution_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_execution_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_execution_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_execution_limits_tenant_policy
  ON agent_run_execution_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_output_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_run_output_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_output_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_run_output_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_output_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_output_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_output_limits_tenant_policy
  ON agent_run_output_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_skill_snapshots ADD COLUMN tenant_id TEXT;
UPDATE agent_run_skill_snapshots AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_skill_snapshots WHERE tenant_id IS NULL;
ALTER TABLE agent_run_skill_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_skill_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_skill_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_skill_snapshots_tenant_policy
  ON agent_run_skill_snapshots
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_provider_model_readiness ADD COLUMN tenant_id TEXT;
UPDATE agent_provider_model_readiness AS child
SET tenant_id = parent.tenant_id
FROM agent_provider_connections AS parent
WHERE parent.id = child.provider_id AND child.tenant_id IS NULL;
DELETE FROM agent_provider_model_readiness WHERE tenant_id IS NULL;
ALTER TABLE agent_provider_model_readiness ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_provider_model_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_provider_model_readiness FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_provider_model_readiness_tenant_policy
  ON agent_provider_model_readiness
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
