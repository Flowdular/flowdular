-- Dropping the threads removes their turns with them; the runs that answered
-- them stay, because a turn never owned one.
DROP TABLE IF EXISTS assistant_turns;
DROP TABLE IF EXISTS assistant_threads;
ALTER TABLE agent_audit_events_v4
  DROP CONSTRAINT IF EXISTS agent_audit_events_v4_subject_type_check;
ALTER TABLE agent_audit_events_v4
  ADD CONSTRAINT agent_audit_events_v4_subject_type_check
  CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action'));
