ALTER TABLE connectors_audit
  DROP CONSTRAINT connectors_audit_action_check;
ALTER TABLE connectors_audit
  ADD CONSTRAINT connectors_audit_action_check
  CHECK (action IN ('instance.created', 'instance.updated', 'instance.consent-changed', 'instance.enabled', 'instance.disabled', 'instance.deleted', 'call.outcome-unknown'));
