ALTER TABLE auth_memberships DROP COLUMN role_id;
DROP TABLE IF EXISTS auth_roles;
DELETE FROM auth_membership_scopes WHERE scope IN ('auth.roles.read', 'auth.roles.manage');
