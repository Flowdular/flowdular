ALTER TABLE parties ADD COLUMN vat_id TEXT
  CHECK (
    vat_id IS NULL OR (
      length(vat_id) BETWEEN 1 AND 20
      AND vat_id NOT GLOB '*[^0-9A-Za-z]*'
    )
  );
