-- A decision provider is a provider connection whose kind answers typed
-- questions instead of generating text. It is stored, sealed, rotated and
-- audited like any other connection, so it is the same table and the same
-- row-level security; only the kind and the consent below are new.
--
-- Widening the check keeps every stored row exactly as written: no existing
-- connection changes, and a kind outside the list is still refused.
ALTER TABLE agent_provider_connections
  DROP CONSTRAINT IF EXISTS agent_provider_connections_kind_check;
ALTER TABLE agent_provider_connections
  ADD CONSTRAINT agent_provider_connections_kind_check
  CHECK (kind IN ('vercel', 'azure', 'openai', 'openai-compatible', 'anthropic', 'typesafe'));

-- Consent per connection, off for every row that already exists and for every
-- row written without it. The workspace flag admits the feature and this
-- column admits the caller kind, so record data reaches a decision provider
-- only after two deliberate acts of that workspace.
ALTER TABLE agent_provider_connections
  ADD COLUMN IF NOT EXISTS allow_workflows INTEGER NOT NULL DEFAULT 0
  CHECK (allow_workflows IN (0, 1));
