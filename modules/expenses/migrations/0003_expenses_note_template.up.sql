ALTER TABLE expenses_claims
  ADD COLUMN note_template TEXT CHECK (note_template IS NULL OR length(note_template) BETWEEN 1 AND 2000);
