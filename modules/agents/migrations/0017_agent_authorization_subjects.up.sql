ALTER TABLE agent_run_actors
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (authorization_subject_json IS JSON AND authorization_subject_json::jsonb ->> 'kind' = 'user'));
UPDATE agent_run_actors
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb ->> 'configuredBy'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
ALTER TABLE agent_action_invocations
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (authorization_subject_json IS JSON AND authorization_subject_json::jsonb ->> 'kind' = 'user'));
UPDATE agent_action_invocations
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb ->> 'configuredBy'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
