-- The rotation command has to find the payloads still sealed with a retired key
-- before it knows whose they are. The retention sweep sees only payloads with an
-- expiry; a rotation covers every live one, so it reads under a policy of its
-- own and is granted the key id alone. The ciphertext stays unreadable on this
-- connection, and every payload it re-seals is read again under the tenant that
-- row named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY workflow_payloads_rotation_policy ON workflow_payloads
  FOR SELECT TO coreloom_background
  USING (kind = 'execution');
GRANT SELECT (encryption_key_id) ON workflow_payloads TO coreloom_background;
