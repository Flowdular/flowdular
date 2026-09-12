-- The rotation command has to find the connections still sealed with a retired
-- key before it knows whose they are. It is granted the routing columns and the
-- key id alone: the nonce, the tag and the ciphertext stay unreadable on this
-- connection, and every row it re-seals is read again under the tenant that row
-- named.
GRANT SELECT (tenant_id, credential_key_id)
  ON agent_provider_connections TO coreloom_background;
