-- The retention sweep must find the classes that are due across every
-- workspace before it knows whose they are. It is granted exactly the routing
-- and policy columns of audit_data_classes: the human label and the owning
-- module id stay invisible to it, and every class it picks is read again under
-- the workspace the routing row named before a single row is removed.
--
-- The retention columns are part of the routing set on purpose. Without them
-- the cross-tenant read cannot tell a class that is kept for ever from one that
-- is due, and the loop would re-read the same never-due classes every interval.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_data_classes_background_policy ON audit_data_classes
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_data_classes FROM coreloom_background;
GRANT SELECT (tenant_id, class_id, sweepable, retention_mode, retention_days, default_retention_days, last_swept_at) ON audit_data_classes TO coreloom_background;
