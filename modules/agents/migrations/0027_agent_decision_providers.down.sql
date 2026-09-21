-- Reversing this removes the consent column, so every decision connection
-- loses the record that its workspace admitted it. A connection of the kind
-- below cannot exist under the narrower check either; delete those rows before
-- reversing, because the constraint refuses them.
ALTER TABLE agent_provider_connections
  DROP COLUMN IF EXISTS allow_workflows;
ALTER TABLE agent_provider_connections
  DROP CONSTRAINT IF EXISTS agent_provider_connections_kind_check;
ALTER TABLE agent_provider_connections
  ADD CONSTRAINT agent_provider_connections_kind_check
  CHECK (kind IN ('vercel', 'azure', 'openai', 'openai-compatible', 'anthropic'));
