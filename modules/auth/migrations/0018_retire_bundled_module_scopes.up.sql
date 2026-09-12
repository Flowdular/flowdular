-- The parties and catalog modules no longer ship, and their read and manage
-- scopes are still granted to memberships created while they did. A grant that
-- nothing declares is a grant nobody reviews, so both pairs are retired here.
--
-- Row security is forced on both tables, and a migration role that is not a
-- superuser is subject to it like any other, so a plain statement would reach
-- no row on a real deployment. The force flag is lifted for the owner and put
-- back inside the same transaction; a role that does not own these tables
-- fails here loudly instead of leaving the grants in place. Nothing else runs
-- against them while the migration lock is held.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('parties.records.read', 'parties.records.manage', 'catalog.items.read', 'catalog.items.manage');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
-- A role row grants too: assigning a role replaces the membership scopes with
-- the list it carries, so a retired scope left in one comes back on the next
-- assignment. Only rows that still name one are rewritten, and their order is
-- preserved.
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('parties.records.read', 'parties.records.manage', 'catalog.items.read', 'catalog.items.manage')),
      '[]')
WHERE scopes_json LIKE '%"parties.records.%'
   OR scopes_json LIKE '%"catalog.items.%';
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
