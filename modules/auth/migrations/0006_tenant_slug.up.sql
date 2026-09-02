ALTER TABLE auth_tenants ADD COLUMN slug TEXT;
UPDATE auth_tenants SET slug = lower(id) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tenants_slug_idx ON auth_tenants(slug);
