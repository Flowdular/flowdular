-- audit.core declares the rest of its own tenant tables as data classes, so the
-- legal holds and the erasure history are exported through the same keyset walk
-- as the chain and the two ledgers, and an erasure plan counts the holds that
-- name the subject. Each of those reads orders inside one workspace by the
-- primary key or filters by the account a hold covers; without these indexes
-- every page would be a pass over the workspace's rows.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_id_idx
  ON audit_legal_holds (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_tenant_id_idx
  ON audit_erasure_runs (tenant_id, id);
-- Partial, because a hold that names no account is never counted for a subject.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_account_idx
  ON audit_legal_holds (tenant_id, account_id)
  WHERE account_id IS NOT NULL;
