REVOKE SELECT (tenant_id, id, next_run_at, enabled) ON automations_schedules FROM coreloom_background;
DROP POLICY IF EXISTS automations_schedules_background_policy ON automations_schedules;
DROP INDEX IF EXISTS automations_schedules_routing_idx;
