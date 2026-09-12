-- Documentation only; Flowdular never executes a down script. Reversing 0027
-- means taking the eleven scopes back from every owner membership and from the
-- built-in owner role row, and profile.self.manage back from every member
-- membership and the built-in member role row. It cannot distinguish a grant
-- this migration made from one a workspace made by assigning a role that names
-- the scope. Nothing 0023, 0024 or 0025 granted is rewritten here.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage')
  AND (account_id, tenant_id) IN (
        SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'owner');
DELETE FROM auth_membership_scopes
WHERE scope = 'profile.self.manage'
  AND (account_id, tenant_id) IN (
        SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'member');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage')),
      '[]')
WHERE builtin = 1 AND key = 'owner';
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope <> 'profile.self.manage'),
      '[]')
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
