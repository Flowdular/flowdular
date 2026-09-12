-- Documentation only; Flowdular never executes a down script. Reversing 0028
-- drops the two prefix indexes. No row and no constraint depends on them, so
-- the only consequence is that a member search reads the workspace and sorts it
-- again.
DROP INDEX IF EXISTS auth_accounts_display_name_prefix_idx;
DROP INDEX IF EXISTS auth_accounts_email_prefix_idx;
