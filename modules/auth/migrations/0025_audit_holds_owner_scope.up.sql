-- audit.core declares audit.holds.manage, and D-AUDIT-HOLD-PERMISSION keeps it
-- with owners: only an owner places or lifts a legal hold. The permission was
-- declared after 0023 backfilled the enterprise module scopes, so an existing
-- workspace carries it on neither its owner memberships nor its built-in owner
-- role row. auth sync-scopes grants a module's declared scopes when the module
-- is enabled, and audit.core was already enabled when this one appeared, so
-- that path does not reach it either. This grants it to every owner
-- membership and appends it to the built-in owner role row. Members receive
-- nothing here: D-AUDIT-PERMISSIONS keeps every audit permission owner-only.
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
CROSS JOIN unnest(ARRAY['audit.holds.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from the built-in owner row would be
-- taken away again at the next assignment. The scopes already held keep their
-- order and the missing one is appended.
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
                 FROM unnest(ARRAY['audit.holds.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
