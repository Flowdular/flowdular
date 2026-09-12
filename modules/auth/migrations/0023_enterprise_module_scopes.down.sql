-- Documentation only; Flowdular never executes a down script. Reversing 0023
-- means retiring the sixteen scopes the way 0018 retires a scope: delete them
-- from every membership and rewrite every role row that still names one. It
-- cannot distinguish a grant this migration made from one auth sync-scopes made
-- for an enabled module, so running it revokes both.
ALTER TABLE auth_membership_scopes NO FORCE ROW LEVEL SECURITY;
DELETE FROM auth_membership_scopes
WHERE scope IN ('directory.tokens.read', 'directory.tokens.manage', 'directory.provisioning.read', 'audit.registry.read', 'audit.retention.manage', 'approvals.requests.read', 'approvals.requests.decide', 'approvals.requests.manage', 'documents.files.read', 'documents.files.manage', 'metering.usage.read', 'import.jobs.read', 'import.jobs.manage', 'search.records.read', 'connectors.instances.read', 'connectors.instances.manage');
ALTER TABLE auth_membership_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_roles NO FORCE ROW LEVEL SECURITY;
UPDATE auth_roles
SET scopes_json = COALESCE(
      (SELECT json_agg(entry.scope ORDER BY entry.position)::text
         FROM json_array_elements_text(auth_roles.scopes_json::json)
              WITH ORDINALITY AS entry(scope, position)
        WHERE entry.scope NOT IN ('directory.tokens.read', 'directory.tokens.manage', 'directory.provisioning.read', 'audit.registry.read', 'audit.retention.manage', 'approvals.requests.read', 'approvals.requests.decide', 'approvals.requests.manage', 'documents.files.read', 'documents.files.manage', 'metering.usage.read', 'import.jobs.read', 'import.jobs.manage', 'search.records.read', 'connectors.instances.read', 'connectors.instances.manage')),
      '[]')
WHERE builtin = 1;
ALTER TABLE auth_roles FORCE ROW LEVEL SECURITY;
