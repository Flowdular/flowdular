ALTER TABLE workflow_runs
  ADD COLUMN authorization_subject_json TEXT;
UPDATE workflow_runs
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
