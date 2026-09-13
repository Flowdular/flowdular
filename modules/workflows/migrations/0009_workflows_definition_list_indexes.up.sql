-- The definitions screen pages by keyset over the order it shows, by name or by
-- last update, each ending in the id. 0001 indexed (tenant_id, name, id), which
-- serves neither an ORDER BY over lower(name) nor one over updated_at, so both
-- orders walked the workspace's rows and sorted them. These two carry each
-- order the way the page reads it.
CREATE INDEX IF NOT EXISTS workflow_definitions_tenant_lower_name_idx
  ON workflow_definitions (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS workflow_definitions_tenant_updated_idx
  ON workflow_definitions (tenant_id, updated_at, id);
