-- notifications.core declares five permissions. Owners receive all five through
-- auth sync-scopes, which module enable runs; members receive none, because the
-- member defaults live in acl/scopes.ts and a built-in role row is seeded once,
-- with ON CONFLICT DO NOTHING, when the workspace is created. So a workspace
-- that already exists would never see the three member scopes. This grants them.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables fails
-- here loudly instead of leaving the grants missing. Nothing else runs against
-- them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['notifications.inbox.read', 'notifications.inbox.manage', 'notifications.webhooks.read']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in member row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing ones are appended in the order acl/scopes.ts declares
-- them, which is the order a freshly seeded workspace writes.
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
                 FROM unnest(ARRAY['notifications.inbox.read', 'notifications.inbox.manage', 'notifications.webhooks.read'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
