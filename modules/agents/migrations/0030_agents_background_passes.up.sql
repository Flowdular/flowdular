-- The worker's binding pass and revision adoption pass, and the one adoption
-- check an opening makes, have to find their work before they know whose it
-- is. On the read-only background role they read identifiers and revisions
-- alone, under a SELECT policy of each table's own; every write that follows
-- runs on the tenant-scoped runtime role, under the tenant the row named.
GRANT SELECT (module_definition_revision)
  ON module_agent_bindings TO coreloom_background;
GRANT SELECT (id, revision) ON agent_definitions TO coreloom_background;
CREATE POLICY agent_definition_revisions_adoption_policy
  ON agent_definition_revisions
  FOR SELECT TO coreloom_background
  USING (true);
GRANT SELECT (tenant_id, agent_id, revision)
  ON agent_definition_revisions TO coreloom_background;
-- The binding pass asks each served definition for the tenants whose binding
-- is behind it, so the common answer, none, is one index probe.
CREATE INDEX IF NOT EXISTS module_agent_bindings_agent_revision_idx
  ON module_agent_bindings (agent_id, module_definition_revision, tenant_id);
