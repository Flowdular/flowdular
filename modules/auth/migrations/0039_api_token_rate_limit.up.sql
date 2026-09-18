-- A token was admitted at whatever rate it asked for, so one runaway
-- integration could take a workspace's API to itself. Each token now carries
-- the requests per minute it may spend; 0 means the token takes the
-- deployment default from the auth.core setting, which an owner changes in
-- Administration without a restart.
ALTER TABLE auth_api_tokens ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER NOT NULL DEFAULT 0;
