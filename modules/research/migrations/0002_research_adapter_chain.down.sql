-- Documentation only; Flowdular never executes a down script. The query rows
-- that name searxng or firecrawl cannot satisfy the narrower check, so they go
-- first, with the force flag lifted for the migrator that holds no tenant.
ALTER TABLE research_queries NO FORCE ROW LEVEL SECURITY;
DELETE FROM research_queries WHERE adapter IN ('searxng', 'firecrawl');
ALTER TABLE research_queries FORCE ROW LEVEL SECURITY;
ALTER TABLE research_queries DROP CONSTRAINT IF EXISTS research_queries_adapter_check;
ALTER TABLE research_queries ADD CONSTRAINT research_queries_adapter_check
  CHECK (adapter IN ('model-native', 'connector', 'recorded'));
DROP TABLE IF EXISTS research_adapter_health;
DROP TABLE IF EXISTS research_attempts;
