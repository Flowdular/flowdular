DROP INDEX IF EXISTS auth_tenants_slug_idx;
ALTER TABLE auth_tenants DROP COLUMN slug;
