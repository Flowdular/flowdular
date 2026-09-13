-- The sorted member listing pages one workspace by display name or by address:
-- ORDER BY lower(a.display_name), a.id (or a.email_normalized, a.id) with a
-- keyset predicate on the same pair and a LIMIT, over auth_memberships joined
-- to auth_accounts for the workspace. Both sort columns live on auth_accounts,
-- which carries no tenant column, so the (tenant_id, sort column, id) index a
-- keyset page normally rests on cannot exist on one table. These indexes go
-- where the sort expressions are. For a workspace that holds most of the
-- deployment's accounts the planner walks the index in order, joins each
-- account to its membership through the primary key (account_id, tenant_id)
-- and stops at the LIMIT, so a page costs the rows it answers. For a small
-- workspace it reads the membership rows through 0030's (tenant_id,
-- account_id) index and sorts that workspace alone, which is bounded by the
-- workspace and never by the deployment. Neither plan reads the deployment's
-- accounts and sorts them.
--
-- 0028's prefix index over lower(display_name) carries text_pattern_ops,
-- whose byte order is the ORDER BY order under the C collation only, so the
-- sort needs its own index in the database collation. The address is already
-- unique, and id follows it here so both keysets have the same shape.
CREATE INDEX IF NOT EXISTS auth_accounts_display_name_keyset_idx
  ON auth_accounts (lower(display_name), id);
CREATE INDEX IF NOT EXISTS auth_accounts_email_keyset_idx
  ON auth_accounts (email_normalized, id);
