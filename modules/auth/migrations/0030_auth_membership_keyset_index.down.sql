-- Documentation only; Flowdular never executes a down script. Reversing 0030
-- means dropping the index, which costs the paged member read its range scan
-- and nothing else: no row, no policy and no grant depends on it.
DROP INDEX IF EXISTS auth_memberships_tenant_keyset_idx;
