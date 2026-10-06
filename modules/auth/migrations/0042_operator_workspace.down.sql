-- Documentation only; Flowdular never executes a down script. Reversing 0042
-- drops the operator record, so no workspace changes a platform-scoped setting
-- until the deployment sets FD_OPERATOR_TENANT, and the auth.operator events
-- already written stay in each workspace's trail.
DROP TABLE IF EXISTS auth_operator_workspace;
