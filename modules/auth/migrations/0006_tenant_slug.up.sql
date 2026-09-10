ALTER TABLE auth_tenants ADD COLUMN IF NOT EXISTS slug TEXT;
UPDATE auth_tenants SET slug = lower(id) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tenants_slug_idx ON auth_tenants(slug);
-- A slug is how a workspace is addressed before one is entered, so the
-- cross-tenant lookup that resolves it reads this column too.
GRANT SELECT (slug) ON auth_tenants TO coreloom_background;
