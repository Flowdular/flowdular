ALTER TABLE agent_run_actors
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (json_valid(authorization_subject_json) AND json_extract(authorization_subject_json, '$.kind') = 'user'));
UPDATE agent_run_actors
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
ALTER TABLE agent_action_invocations
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (json_valid(authorization_subject_json) AND json_extract(authorization_subject_json, '$.kind') = 'user'));
UPDATE agent_action_invocations
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
