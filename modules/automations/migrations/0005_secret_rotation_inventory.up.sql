-- The rotation command has to find the triggers still sealed with a retired key
-- before it knows whose they are. The cross-tenant lookup already reads the two
-- routing columns; this adds the key id and nothing else. The nonce, the tag and
-- the ciphertext stay unreadable on this connection, and every row it re-seals
-- is read again under the tenant that row named.
GRANT SELECT (secret_key_id) ON automations_triggers TO coreloom_background;
