ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE auth_accounts ADD COLUMN IF NOT EXISTS password_change_required INTEGER NOT NULL DEFAULT 0;
UPDATE auth_sessions SET id = replace(gen_random_uuid()::text, '-', '') WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_id_idx ON auth_sessions (id);
-- Revoking one session of an account names it by this id and no workspace, so
-- the cross-tenant lookup that routes it reads this column too.
GRANT SELECT (id) ON auth_sessions TO coreloom_background;
