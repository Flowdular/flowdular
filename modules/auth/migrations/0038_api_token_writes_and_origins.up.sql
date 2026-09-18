-- An API token is a machine credential, and until now it could only read: a
-- session-guarded mutation refused it outright. A headless caller needs to
-- write too, so the permission to do so becomes a property of the token the
-- owner issues rather than a property of every token at once. allow_writes is
-- 0 unless the owner asked for it, so every token already issued stays
-- read-only.
--
-- allowed_origins_json lists the browser origins that may present the token.
-- An empty list means no browser origin may: the token is for a server-side
-- caller, which sends no Origin header.
ALTER TABLE auth_api_tokens ADD COLUMN IF NOT EXISTS allow_writes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_api_tokens ADD COLUMN IF NOT EXISTS allowed_origins_json TEXT NOT NULL DEFAULT '[]';
-- The cross-origin preflight carries no credential, so the deployment answers
-- it from the origins its live tokens declare. That read runs on the routing
-- role, which holds a column grant rather than a table grant; it learns which
-- origins are registered somewhere in the deployment and no workspace data.
GRANT SELECT (allowed_origins_json, expires_at) ON auth_api_tokens TO coreloom_background;
CREATE INDEX IF NOT EXISTS auth_api_tokens_live_origins_idx
  ON auth_api_tokens (revoked_at, expires_at);
