-- The trace that enqueued the job, as a W3C traceparent header value, so the
-- pass that claims it can be read against the request that started it. Nullable
-- because a job enqueued outside a traced scope, and every job that predates
-- this column, is a new root. It is written once at insert and never used as a
-- predicate, so it carries no index and stays off the background routing grant:
-- the claim returns it under the tenant that owns the job.
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS traceparent text;
