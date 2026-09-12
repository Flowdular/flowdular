-- The scope backfills 0019, 0022, 0023, 0024, 0025, 0027 and 0029 grant the
-- permissions a module declares to the memberships that existed when the
-- module was enabled. Each lifted the force flag on auth_membership_scopes and
-- on auth_roles, but selected the memberships from auth_memberships, which
-- forces row security as well (0001). A migrator that is not a superuser is
-- subject to that policy and holds no tenant setting, so on a PostgreSQL
-- deployment every one of those selects matched nothing and no membership
-- gained a scope; PGlite runs as a superuser and did not notice. The built-in
-- role rows those migrations rewrote were read from auth_roles under its own
-- lifted flag and are correct.
--
-- Applied migrations are immutable, so this repeats the seven membership
-- grants with the force flag lifted on the source table as well, inside the
-- same transaction, on the same conflict rule. A scope a workspace granted
-- since, by assigning a role that names it, is left in place.
ALTER TABLE auth_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['auth.providers.read', 'auth.providers.manage', 'directory.tokens.read', 'directory.tokens.manage', 'directory.provisioning.read', 'audit.registry.read', 'audit.retention.manage', 'approvals.requests.read', 'approvals.requests.decide', 'approvals.requests.manage', 'documents.files.read', 'documents.files.manage', 'metering.usage.read', 'import.jobs.read', 'import.jobs.manage', 'search.records.read', 'connectors.instances.read', 'connectors.instances.manage', 'audit.holds.manage', 'workflows.definitions.read', 'workflows.definitions.manage', 'workflows.definitions.publish', 'workflows.runs.read', 'workflows.runs.execute', 'workflows.runs.cancel', 'automations.schedules.read', 'automations.schedules.manage', 'automations.triggers.read', 'automations.triggers.manage', 'profile.self.manage', 'reports.workspace.read', 'exports.lists.read', 'exports.lists.manage', 'access.review.read', 'access.review.manage']) AS granted(scope)
WHERE auth_memberships.role = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
SELECT account_id, tenant_id, scope
FROM auth_memberships
CROSS JOIN unnest(ARRAY['notifications.inbox.read', 'notifications.inbox.manage', 'notifications.webhooks.read', 'documents.files.read', 'documents.files.manage', 'search.records.read', 'connectors.instances.read', 'approvals.requests.read', 'approvals.requests.decide', 'profile.self.manage']) AS granted(scope)
WHERE auth_memberships.role = 'member'
ON CONFLICT DO NOTHING;
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_memberships FORCE ROW LEVEL SECURITY;
