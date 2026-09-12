-- Documentation only; Flowdular never executes a down script. Reversing 0024
-- means taking the two scopes back from every member membership and from the
-- built-in member role row. It cannot distinguish a grant this migration made
-- from one a workspace made by assigning a role that names the scope. The owner
-- grants of 0023 survive it: no owner membership and no owner role row is
-- rewritten here.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('approvals.requests.read', 'approvals.requests.decide')
  AND (account_id, tenant_id) IN (
        SELECT account_id, tenant_id FROM auth_memberships WHERE role = 'member');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('approvals.requests.read', 'approvals.requests.decide')),
      '[]')
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
