-- Member search matched a display name anywhere, LIKE '%term%', which no index
-- can answer: every keystroke read the workspace and sorted it before the LIMIT
-- cut it. Both branches are prefixes now, and these indexes turn each branch
-- into a range scan of the rows it returns. The ordering is still a sort, over
-- the rows the prefix matched rather than over the workspace.
--
-- The operator class is the load-bearing part. A btree over text in any
-- collation but C orders by that collation, while LIKE 'term%' is a range in
-- byte order, so an index in the database's default collation is ignored on a
-- deployment created with a locale and the workspace scan comes back unnoticed.
-- text_pattern_ops states the byte order the prefix needs, so the same plan
-- holds under every collation. The unique index on email_normalized stays the
-- key it is; it answers equality, and under C collation the prefix as well.
--
-- Neither index carries a workspace column because auth_accounts carries none.
-- A search reaches an account through auth_memberships, whose policy and
-- primary key bind the workspace to it.
CREATE INDEX IF NOT EXISTS auth_accounts_display_name_prefix_idx
  ON auth_accounts (lower(display_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS auth_accounts_email_prefix_idx
  ON auth_accounts (email_normalized text_pattern_ops);
