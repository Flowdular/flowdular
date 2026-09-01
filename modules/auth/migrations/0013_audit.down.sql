DROP TABLE IF EXISTS auth_audit;
DELETE FROM auth_membership_scopes WHERE scope = 'auth.audit.read';
