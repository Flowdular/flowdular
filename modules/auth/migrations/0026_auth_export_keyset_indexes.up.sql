-- The three data class export walks page one workspace by keyset:
-- WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3. No index ordered that
-- pair, so every page sorted the whole workspace again: auth_sessions carried
-- (account_id, expires_at), (expires_at) and a unique (id); auth_api_tokens
-- (tenant_id, revoked_at, created_at DESC); auth_audit
-- (tenant_id, occurred_at DESC, id DESC). These three turn each page into an
-- index range scan of exactly the rows it returns, which is what makes an
-- export of a large workspace linear in the rows it carries rather than
-- quadratic in them.
CREATE INDEX IF NOT EXISTS auth_sessions_tenant_keyset_idx
  ON auth_sessions (tenant_id, id);
CREATE INDEX IF NOT EXISTS auth_api_tokens_tenant_keyset_idx
  ON auth_api_tokens (tenant_id, id);
CREATE INDEX IF NOT EXISTS auth_audit_tenant_keyset_idx
  ON auth_audit (tenant_id, id);
