-- Documentation only; Flowdular never executes a down script. Reversing 0029
-- means taking the five scopes back from every owner membership and from the
-- built-in owner role row. It cannot distinguish a grant this migration made
-- from one a workspace made by assigning a role that names the scope. Nothing
-- 0023, 0024, 0025 or 0027 granted is rewritten here, and no member membership
-- and no member role row is touched, because this migration granted them none.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('reports.workspace.read', 'exports.lists.read', 'exports.lists.manage', 'access.review.read', 'access.review.manage')
  AND (account_id, tenant_id) IN (
        SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'owner');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('reports.workspace.read', 'exports.lists.read', 'exports.lists.manage', 'access.review.read', 'access.review.manage')),
      '[]')
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
