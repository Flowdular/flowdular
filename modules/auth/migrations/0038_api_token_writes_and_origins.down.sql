-- Documentation only; Flowdular never executes a down script. Reversing 0037
-- means dropping both columns, which takes the write permission and the origin
-- binding away from every token that holds one, and taking back the column
-- grant the preflight read needs.
DROP INDEX IF EXISTS auth_api_tokens_live_origins_idx;
REVOKE SELECT (allowed_origins_json, expires_at) ON auth_api_tokens FROM coreloom_background;
ALTER TABLE auth_api_tokens DROP COLUMN IF EXISTS allowed_origins_json;
ALTER TABLE auth_api_tokens DROP COLUMN IF EXISTS allow_writes;
