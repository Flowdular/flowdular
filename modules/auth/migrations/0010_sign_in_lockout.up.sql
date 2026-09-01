CREATE TABLE IF NOT EXISTS auth_sign_in_failures (
  email_normalized TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_sign_in_failures_updated_idx
  ON auth_sign_in_failures (updated_at);
