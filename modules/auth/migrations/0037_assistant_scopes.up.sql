-- agents.core declares agents.assistant.use, the permission a person needs to
-- talk to the workspace assistant and read their own conversations. Owners and
-- members both hold it, because the assistant acts as the member who asked and
-- never above them, and a member without it sees no entry point at all. The
-- seed lists in acl/scopes.ts reach a workspace created from now on; this
-- grants the same default to the memberships and the built-in role rows that
-- already exist, whether or not auth sync-scopes reached them.
--
-- Row security is forced on all three tables and the migrator holds no tenant
-- setting, so the force flag is lifted on the source and the target for the
-- owner and put back inside the same transaction, as 0036 does.
ALTER TABLE auth_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, 'agents.assistant.use'
FROM auth_memberships
WHERE auth_memberships.role IN ('owner', 'member')
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
-- A role row grants too, and assigning a role replaces the membership scopes
-- with its list, so the built-in rows gain the same default: the scopes already
-- held keep their order and the missing one is appended.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['agents.assistant.use'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key IN ('owner', 'member');
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
