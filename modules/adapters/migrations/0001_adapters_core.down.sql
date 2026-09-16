REVOKE SELECT (tenant_id, adapter_id, enabled, next_run_at) ON adapter_bindings FROM coreloom_background;
REVOKE SELECT (tenant_id, id, status, queued_at, lease_until) ON adapter_runs FROM coreloom_background;
DROP TABLE IF EXISTS adapter_audit_events;
DROP TABLE IF EXISTS adapter_run_rows;
DROP TABLE IF EXISTS adapter_runs;
DROP TABLE IF EXISTS adapter_bindings;
