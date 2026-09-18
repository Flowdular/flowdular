-- Documentation only; Flowdular never executes a down script. Reversing 0039
-- means dropping the column, which takes every token's own ceiling away and
-- leaves only the deployment default.
ALTER TABLE auth_api_tokens DROP COLUMN IF EXISTS rate_limit_per_minute;
