-- A page of documents is keyed on (created_at, id) in one direction, so the
-- index carries both columns descending. The index shipped with 0001 orders id
-- ascending under a descending created_at, which no scan direction turns into
-- the order a keyset page walks.
CREATE INDEX IF NOT EXISTS documents_files_page_idx
  ON documents_files (tenant_id, created_at DESC, id DESC);
