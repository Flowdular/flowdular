# Agentic core migrations

`0001_agents_core.up.sql` owns tenant-scoped agent definitions, durable runs,
execution events, leases, and the module audit hash chain. The matching down
migration is destructive and exists for controlled local rollback only.

`0012` adds run-cost accounting and backfills tokens for runs that completed
before it landed. Those rows stay unpriced, because the price a run was billed
at is not recoverable after the fact.

`0009` adopts the pre-ledger v3 audit projection created by the former
automation subsystem. Its exact table and index fingerprints and its complete
v2 row copy are checked before adoption.

`0013` retains every agent definition revision as an immutable executable
snapshot, adds workflow-bound run output contracts, and introduces the durable
versioned action queue.

`0014` moves audit writes to v4, whose subject constraint covers both the
historical schedule and trigger events and workflow action invocations. It
copies the existing v3 chain byte for byte.

`0015` persists the full normalized actor beside each run. Pre-existing rows
retain their historical requester id as a user actor because the old schema did
not record enough provenance to infer an agent run or a service configurator.

`0016` stores module-owned business-agent definitions, tenant execution
bindings, and the immutable ownership lineage of executable revisions. Module
definitions remain after a module disappears so completed runs and workflow
references retain their evidence.

`0017` stores the delegated user separately from the run or action audit actor.
Workers use that user for live authorization, while audit and record history
continue to attribute work to the actual service or business agent.
