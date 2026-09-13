-- Documentation only; Flowdular never executes a down script. Reversing 0033
-- drops the two keyset indexes. No row and no constraint depends on them, so
-- the only consequence is that a sorted member page sorts the workspace again.
DROP INDEX IF EXISTS auth_accounts_display_name_keyset_idx;
DROP INDEX IF EXISTS auth_accounts_email_keyset_idx;
