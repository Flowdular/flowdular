-- decisions.core declares six permissions. Owners hold all six; members read
-- definitions and redacted invocation history but cannot invoke or manage
-- connections. The seed lists cover new workspaces. This migration grants the
-- same defaults to existing built-in role rows and their memberships, without
-- altering custom roles or memberships assigned to them.
--
-- The migrator has no tenant setting. Lift forced row-level security on both
-- the source and target inside the migration transaction, then restore it.
ALTER TABLE auth_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, granted.scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['decisions.definitions.read', 'decisions.definitions.manage', 'decisions.invocations.manage', 'decisions.invocations.read', 'decisions.connections.manage', 'decisions.connections.read']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, granted.scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['decisions.definitions.read', 'decisions.invocations.read']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
-- Assigning a role replaces membership scopes, so append only missing values
-- to the built-in role rows. The existing order and explicit grants survive.
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
                 FROM unnest(ARRAY['decisions.definitions.read', 'decisions.definitions.manage', 'decisions.invocations.manage', 'decisions.invocations.read', 'decisions.connections.manage', 'decisions.connections.read'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'owner';
UPDATE auth_roles
SET scopes_json = (
      SELECT json_agg(entry.scope ORDER BY entry.origin, entry.position)::text
        FROM (
               SELECT 0 AS origin, held.position, held.scope
                 FROM json_array_elements_text(auth_roles.scopes_json::json)
                      WITH ORDINALITY AS held(scope, position)
               UNION ALL
               SELECT 1 AS origin, added.position, added.scope
                 FROM unnest(ARRAY['decisions.definitions.read', 'decisions.invocations.read'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
