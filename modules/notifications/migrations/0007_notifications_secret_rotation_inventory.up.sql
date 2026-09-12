-- The rotation command has to find the subscriptions still sealed with a
-- retired key before it knows whose they are, and the subscriptions table is
-- invisible to the cross-tenant role: it carries no background policy and the
-- role holds no default table grant. This adds the tenant id and the key id and
-- nothing else. The nonce, the tag, the ciphertext, the URL and the fingerprint
-- stay unreadable on this connection, and every row it re-seals is read again
-- under the tenant that row named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY notifications_webhook_subscriptions_background_policy ON notifications_webhook_subscriptions
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON notifications_webhook_subscriptions FROM coreloom_background;
GRANT SELECT (tenant_id, secret_key_id) ON notifications_webhook_subscriptions TO coreloom_background;
