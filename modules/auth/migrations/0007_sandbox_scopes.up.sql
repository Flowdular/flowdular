INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.use' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.access.manage' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.sessions.read' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.preview.data' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) SELECT account_id, tenant_id, 'sandbox.modules.eject' FROM auth_memberships WHERE role = 'owner' ON CONFLICT DO NOTHING;
DELETE FROM auth_membership_scopes
WHERE scope IN ('sandbox.access.use', 'sandbox.access.manage', 'sandbox.sessions.read', 'sandbox.preview.data', 'sandbox.modules.eject')
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role <> 'owner'
  );
