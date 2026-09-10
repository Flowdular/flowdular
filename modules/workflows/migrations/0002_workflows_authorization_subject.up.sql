ALTER TABLE workflow_runs
  ADD COLUMN authorization_subject_json TEXT;
UPDATE workflow_runs
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb -> 'configuredBy' #>> '{}'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
