# Agentic core migrations

`0001_agents_core.up.sql` owns tenant-scoped agent definitions, durable runs,
execution events, leases, and the module audit hash chain. The matching down
migration is destructive and exists for controlled local rollback only.
