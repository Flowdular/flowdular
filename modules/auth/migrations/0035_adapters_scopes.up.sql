-- adapters.core declares two permissions and both stay with owners: an adapter
-- writes records of other modules and reaches other systems, so neither is a
-- member default. The seed lists in acl/scopes.ts reach a workspace created
-- from now on; this grants the same defaults to the owner memberships and the
-- built-in owner role rows that already exist, whether or not auth sync-scopes
-- reached them when the module was enabled.
--
-- Row security is forced on all three tables and the migrator holds no tenant
-- setting, so the force flag is lifted on the source and the target for the
-- owner and put back inside the same transaction, as 0031 does.
ALTER TABLE auth_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['adapters.runs.read', 'adapters.runs.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
-- A role row grants too, and assigning a role replaces the membership scopes
-- with its list, so the built-in owner row gains the same defaults: the scopes
-- already held keep their order and the missing ones are appended in the order
-- acl/scopes.ts declares them.
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
                 FROM unnest(ARRAY['adapters.runs.read', 'adapters.runs.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
