-- Membership status is per workspace: disabling a member in one workspace
-- revokes that membership's sessions and tokens and refuses its sign-in, and
-- leaves the person's other memberships untouched. The account status column
-- stays what it was, the deployment operator's platform-level block.
ALTER TABLE auth_memberships ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_memberships_status_check'
  ) THEN
    ALTER TABLE auth_memberships ADD CONSTRAINT auth_memberships_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;
END
$$;
-- A session cookie, a bearer token and an email address name no workspace, so
-- the routing read decides which membership answers for them. A disabled
-- membership must not be that answer, which is a column this role now reads.
GRANT SELECT (status) ON auth_memberships TO coreloom_background;
