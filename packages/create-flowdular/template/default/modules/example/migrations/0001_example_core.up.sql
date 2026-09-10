CREATE TABLE IF NOT EXISTS example_notes (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS example_notes_tenant_created_idx ON example_notes (tenant_id, created_at DESC);
ALTER TABLE example_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY example_notes_tenant_policy ON example_notes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
