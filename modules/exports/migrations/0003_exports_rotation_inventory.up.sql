-- The storage key rotation has to find the workspaces that still hold export
-- files before it knows which files those are. The routing policy shows the
-- background role only waiting and running jobs; this one adds the completed
-- jobs under the same four routing columns, so the object id, the list, the
-- requester and every count stay invisible to it, and every file it names is
-- read again under the workspace that row named.
CREATE POLICY exports_jobs_rotation_policy ON exports_jobs
  FOR SELECT TO coreloom_background
  USING (status = 'completed');
