DROP TABLE IF EXISTS module_settings;
DELETE FROM auth_membership_scopes WHERE scope IN ('system.settings.read', 'system.settings.manage');
