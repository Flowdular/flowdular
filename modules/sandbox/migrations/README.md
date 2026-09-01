# Sandbox core migrations

`0001_sandbox_core.up.sql` owns tenant-scoped sandbox access grants, sandbox
session records, and the module audit hash chain. Draft source code, chat
transcripts, and provider credentials stay in the sandbox application and never
reach this database. The matching down migration is destructive and exists for
controlled local rollback only.
