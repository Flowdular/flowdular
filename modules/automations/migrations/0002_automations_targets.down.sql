ALTER TABLE automations_triggers DROP COLUMN permission_snapshot_json;
ALTER TABLE automations_triggers DROP COLUMN configured_by_json;
ALTER TABLE automations_triggers DROP COLUMN target_key;
ALTER TABLE automations_triggers DROP COLUMN target_kind;

ALTER TABLE automations_schedules DROP COLUMN permission_snapshot_json;
ALTER TABLE automations_schedules DROP COLUMN configured_by_json;
ALTER TABLE automations_schedules DROP COLUMN target_key;
ALTER TABLE automations_schedules DROP COLUMN target_kind;
