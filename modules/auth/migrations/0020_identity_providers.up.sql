-- A workspace may offer OIDC providers of its own beside the platform providers
-- FD_AUTH_OIDC_PROVIDERS configures at boot. Such a provider is workspace data,
-- so the row carries the tenant column and the forced policy every
-- workspace-owned table carries. The client secret is stored only as the sealed
-- envelope the auth keyring writes, beside the id of the key that sealed it, so
-- auth secrets-rotate re-seals these rows exactly as it re-seals enrolled
-- factors. The discovery endpoints are stored because they are what discovery
-- answered when the issuer was verified, not administrator input; keeping them
-- means a sign-in costs no outbound discovery request.
CREATE TABLE IF NOT EXISTS auth_identity_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES auth_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  user_info_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_key_id TEXT NOT NULL,
  client_secret_fingerprint TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  jit_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  jit_role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS auth_identity_providers_tenant_idx
  ON auth_identity_providers (tenant_id, key, id);
ALTER TABLE auth_identity_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identity_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_identity_providers_tenant_policy ON auth_identity_providers
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A platform provider asserts an identity about an account before any workspace
-- is chosen, and keeps binding without one. A tenant-owned provider asserts it
-- inside its own workspace only, so the binding carries that workspace and the
-- pair (provider, subject) is unique per workspace rather than globally. The
-- primary key 0016 put on the pair would let one workspace's binding block
-- another's, so it goes and two partial unique indexes take its place.
ALTER TABLE auth_external_identities
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES auth_tenants(id) ON DELETE CASCADE;
ALTER TABLE auth_external_identities
  DROP CONSTRAINT IF EXISTS auth_external_identities_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS auth_external_identities_platform_idx
  ON auth_external_identities (provider, subject) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_external_identities_workspace_idx
  ON auth_external_identities (tenant_id, provider, subject) WHERE tenant_id IS NOT NULL;
-- The workspace rows are workspace data and the policy scopes them to their
-- tenant; the platform rows carry no workspace and stay readable under the
-- identity context that has always written them.
ALTER TABLE auth_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_external_identities_tenant_policy ON auth_external_identities
  USING (tenant_id IS NULL OR tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('coreloom.tenant_id', true));
