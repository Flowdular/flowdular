ALTER TABLE automations_schedules
  ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_schedules
  ADD COLUMN target_key TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN configured_by_json TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_schedules
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_schedules
SET configured_by_json = json_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)
WHERE configured_by_json IS NULL;

ALTER TABLE automations_triggers
  ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_triggers
  ADD COLUMN target_key TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN configured_by_json TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_triggers
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_triggers
SET configured_by_json = json_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)
WHERE configured_by_json IS NULL;
