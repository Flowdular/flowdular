-- Documentation only; Flowdular never executes down migrations. Reversing
-- 0040 removes decisions.core defaults from built-in role rows and their
-- memberships, but cannot distinguish a prior explicit grant of the same
-- scope. Restore a pre-migration snapshot to preserve such grants exactly.
ALTER TABLE auth_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes AS grants
USING auth_memberships AS memberships
WHERE grants.account_id = memberships.account_id
  AND grants.tenant_id = memberships.tenant_id
  AND memberships.role IN ('owner', 'member')
  AND grants.scope IN (
    'decisions.definitions.read',
    'decisions.definitions.manage',
    'decisions.invocations.manage',
    'decisions.invocations.read',
    'decisions.connections.manage',
    'decisions.connections.read'
  );
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN (
          'decisions.definitions.read',
          'decisions.definitions.manage',
          'decisions.invocations.manage',
          'decisions.invocations.read',
          'decisions.connections.manage',
          'decisions.connections.read'
        )),
      '[]')
WHERE builtin = 1 AND key IN ('owner', 'member');
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
