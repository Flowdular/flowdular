DELETE FROM auth_membership_scopes
WHERE scope IN (
  'users.members.read',
  'users.members.manage',
  'parties.records.read',
  'parties.records.manage',
  'catalog.items.read',
  'catalog.items.manage'
);
INSERT OR IGNORE INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'system.modules.read'
FROM auth_memberships
WHERE role = 'member';
