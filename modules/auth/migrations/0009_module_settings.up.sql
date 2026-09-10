CREATE TABLE IF NOT EXISTS module_settings (
  tenant_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, module_id, key)
);
ALTER TABLE module_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY module_settings_tenant_policy ON module_settings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'system.settings.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope IN ('system.settings.read', 'system.settings.manage')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
