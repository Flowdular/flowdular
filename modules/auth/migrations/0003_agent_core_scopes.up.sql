INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.read' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.runs.execute' FROM auth_memberships
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.definitions.manage' FROM auth_memberships WHERE role = 'owner'
ON CONFLICT DO NOTHING;
