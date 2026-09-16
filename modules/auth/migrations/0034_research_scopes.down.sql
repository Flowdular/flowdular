-- Documentation only; Flowdular never executes a down script. Reversing 0034
-- means taking the research scopes back from every membership and from the
-- built-in role rows. It cannot distinguish a grant this migration made from
-- one a workspace made by assigning a role that names the scope.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('research.evidence.read', 'research.run', 'research.settings.manage');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('research.evidence.read', 'research.run', 'research.settings.manage')),
      '[]')
WHERE builtin = 1 AND key IN ('owner', 'member');
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
