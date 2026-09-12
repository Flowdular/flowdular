-- Documentation only; Flowdular never executes a down script. Reversing 0026
-- drops the three keyset indexes. No row and no constraint depends on them, so
-- the only consequence is that an export walk sorts each page again.
DROP INDEX IF EXISTS auth_sessions_tenant_keyset_idx;
DROP INDEX IF EXISTS auth_api_tokens_tenant_keyset_idx;
DROP INDEX IF EXISTS auth_audit_tenant_keyset_idx;
