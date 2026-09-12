-- workflows.core, automations.core and profile.core declare eleven permissions
-- between them, and owners hold every permission an enabled module declares.
-- All three were already enabled when the owner defaults gained them, so auth
-- sync-scopes does not reach an existing workspace: it grants a module's scopes
-- when the module is enabled and to the workspaces that exist at that moment.
-- The seed lists in acl/scopes.ts reach a workspace created from now on and no
-- earlier one. This grants the eleven to every owner membership and appends
-- them to the built-in owner role row. Members receive profile.self.manage
-- alone, because every member manages their own profile, language, password
-- and sessions, while the workflow and automation permissions stay with owners.
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
CROSS JOIN unnest(ARRAY['workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['profile.self.manage']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a scope missing from a built-in row would be taken
-- away again at the next assignment. The scopes already held keep their order
-- and the missing ones are appended in the order acl/scopes.ts declares them,
-- which is the order a freshly seeded workspace writes.
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
                 FROM unnest(ARRAY['workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage'])
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
                 FROM unnest(ARRAY['profile.self.manage'])
                      WITH ORDINALITY AS added(scope, position)
                WHERE added.scope NOT IN (
                        SELECT existing.scope
                          FROM json_array_elements_text(auth_roles.scopes_json::json) AS existing(scope))
             ) AS entry
    )
WHERE builtin = 1 AND key = 'member';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
