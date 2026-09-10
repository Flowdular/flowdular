-- Failures are counted per email address before a workspace, and usually before
-- an account, is known, so this table carries no tenant column and no policy.
-- locked_until holds an epoch in milliseconds, which overflows INTEGER.
CREATE TABLE IF NOT EXISTS auth_sign_in_failures (
  email_normalized TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sign_in_failures_updated_idx
  ON auth_sign_in_failures (updated_at);
