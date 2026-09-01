-- Each ALTER runs only when pragma_table_info shows the column is missing.
ALTER TABLE auth_sessions ADD COLUMN id TEXT;
ALTER TABLE auth_accounts ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0;
UPDATE auth_sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_id_idx ON auth_sessions (id);
