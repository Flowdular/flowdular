-- Reversing this leaves the worker passes and the opening adoption check
-- unable to read; run it only together with a release that no longer makes them.
DROP INDEX IF EXISTS module_agent_bindings_agent_revision_idx;
REVOKE SELECT (tenant_id, agent_id, revision)
  ON agent_definition_revisions FROM flowdular_background;
DROP POLICY IF EXISTS agent_definition_revisions_adoption_policy
  ON agent_definition_revisions;
REVOKE SELECT (id, revision) ON agent_definitions FROM flowdular_background;
REVOKE SELECT (module_definition_revision)
  ON module_agent_bindings FROM flowdular_background;
