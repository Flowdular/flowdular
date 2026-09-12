-- The rows are standing refusals, not history: dropping the table only makes
-- the next refusal of each workspace and meter record its audit event again.
DROP TABLE IF EXISTS agent_meter_refusals;
