DROP TABLE IF EXISTS auth_api_tokens;
DELETE FROM auth_membership_scopes WHERE scope IN ('auth.tokens.read', 'auth.tokens.manage');
