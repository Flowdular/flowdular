DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM connectors_audit WHERE action = 'call.outcome-unknown') THEN
    RAISE EXCEPTION 'Cannot remove the unknown-call audit action while its evidence exists.';
  END IF;
END
$$;
ALTER TABLE connectors_audit
  DROP CONSTRAINT connectors_audit_action_check;
ALTER TABLE connectors_audit
  ADD CONSTRAINT connectors_audit_action_check
  CHECK (action IN ('instance.created', 'instance.updated', 'instance.consent-changed', 'instance.enabled', 'instance.disabled', 'instance.deleted'));
