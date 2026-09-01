DROP INDEX IF EXISTS auth_sessions_id_idx;
ALTER TABLE auth_sessions DROP COLUMN id;
ALTER TABLE auth_accounts DROP COLUMN password_change_required;
