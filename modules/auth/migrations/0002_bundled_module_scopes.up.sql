INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.read' FROM auth_memberships;
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'users.members.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'parties.records.manage' FROM auth_memberships WHERE role = 'owner';
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'catalog.items.manage' FROM auth_memberships WHERE role = 'owner';
DELETE FROM auth_membership_scopes
WHERE scope = 'system.modules.read'
  AND EXISTS (
    SELECT 1 FROM auth_memberships
    WHERE auth_memberships.account_id = auth_membership_scopes.account_id
      AND auth_memberships.tenant_id = auth_membership_scopes.tenant_id
      AND auth_memberships.role = 'member'
  );
