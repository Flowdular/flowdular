# ADR 0002: Durable agent execution

- Status: accepted
- Date: 2026-08-31

## Decision

`agents.core` owns tenant-scoped agent definitions, a durable execution queue, run history, execution events, and module-local audit evidence. An enqueue request commits a queued run before it returns `202 Accepted`. A background worker claims work with an expiring lease, renews the lease while active, and recovers queued or expired claims after runtime restart.

The browser and session that requested a run do not own its lifecycle. Closing the page, navigating away, or signing out after the enqueue commit does not cancel the run. The run stores an immutable snapshot of the agent revision, provider, model, limits, input, initiating subject, tool grants, and permission evidence used to authorize the request.

Agent instructions are data, not authority. The harness exposes only tools registered by the platform composition root. Each tool records either an approved API endpoint identifier or an approved CLI capability identifier, declares required permissions, and receives a trusted tenant and subject context. Agent code must not import business repositories, open another module's database, execute arbitrary shell commands, or load executable code at runtime.

The local simulation provider is deterministic and performs no network request. Production providers and business tools must be registered explicitly and receive separate specifications, secret handling, budgets, rate limits, and operational monitoring.

`agents.core` may use its own SQLite database for agent definitions, queue state, events, and audit records. That database is not an integration path to ERP business data.
