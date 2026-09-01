DELETE FROM auth_membership_scopes
WHERE scope IN ('system.modules.read', 'system.specs.read', 'system.runs.read')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
