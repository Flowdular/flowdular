-- The credential key rotation has to find the instances still sealed with a
-- retired key before it knows whose they are, so the cross-tenant role may read
-- the key id of every row that holds an envelope and nothing else: the nonce,
-- the tag, the ciphertext and the fingerprint stay unreadable on this
-- connection, and every row it re-seals is read again under the workspace that
-- row named. PostgreSQL checks column privileges in WHERE too, so the key id is
-- part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY connectors_instances_background_policy ON connectors_instances
  FOR SELECT TO coreloom_background
  USING (credential_key_id IS NOT NULL);
REVOKE SELECT ON connectors_instances FROM coreloom_background;
GRANT SELECT (tenant_id, credential_key_id) ON connectors_instances TO coreloom_background;
