-- The kernel actor model has three kinds: a user, an agent run and a service
-- configured by a user. 0014 admitted the first two, so an operator command
-- and an identity provider were recorded as users. This admits the service
-- kind and stores the configuring user beside it, the way the record history
-- tables do; null where the row is no service, or where the configuring user
-- is not stored, as an identity provider's is not.
ALTER TABLE auth_audit DROP CONSTRAINT IF EXISTS auth_audit_actor_kind_check;
ALTER TABLE auth_audit ADD CONSTRAINT auth_audit_actor_kind_check
  CHECK (actor_kind IN ('user', 'agent', 'service'));
ALTER TABLE auth_audit ADD COLUMN IF NOT EXISTS configured_by_json TEXT NULL;
