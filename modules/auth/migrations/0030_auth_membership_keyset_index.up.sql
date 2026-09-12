-- The paged member read walks one workspace by keyset:
-- WHERE tenant_id = $1 AND account_id > $2 ORDER BY account_id LIMIT $3. The
-- primary key of auth_memberships is (account_id, tenant_id), which leads with
-- the account, so that walk is a scan over every workspace's rows after the
-- cursor with the workspace applied as a filter. This index leads with the
-- workspace, which turns each page into an index range scan of exactly the
-- rows it returns and makes the walk linear in the members it carries rather
-- than in the deployment.
CREATE INDEX IF NOT EXISTS auth_memberships_tenant_keyset_idx
  ON auth_memberships (tenant_id, account_id);
