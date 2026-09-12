-- Documentation only; Flowdular never executes a down script. Reversing 0025
-- means taking audit.holds.manage back from every owner membership and from the
-- built-in owner role row. It cannot distinguish a grant this migration made
-- from one a workspace made by assigning a role that names the scope. Nothing
-- 0023 or 0024 granted is rewritten here.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope = 'audit.holds.manage'
  AND (account_id, tenant_id) IN (
        SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'owner');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope <> 'audit.holds.manage'),
      '[]')
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
