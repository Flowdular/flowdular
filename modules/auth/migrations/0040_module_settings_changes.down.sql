-- Documentation only; Flowdular never executes a down script. Reversing 0040
-- drops the change log, so every process falls back to serving its snapshot
-- until it restarts, and a platform setting change still marked audit pending
-- loses its event.
DROP INDEX IF EXISTS auth_audit_settings_revision_idx;
ALTER TABLE auth_audit DROP COLUMN IF EXISTS settings_revision;
DROP TABLE IF EXISTS module_settings_changes;
