REVOKE SELECT (tenant_id, id) ON automations_triggers FROM flowdular_background;
DROP POLICY IF EXISTS automations_triggers_background_policy ON automations_triggers;
DROP INDEX IF EXISTS automations_triggers_routing_idx;
