---
name: workflow-development
description: Build, publish, invoke, and test a workflows.core DAG through its typed graph and public execution capability without bypassing agent, action, tenant, or audit boundaries.
roles:
  - agentic-engineer
  - backend-engineer
  - frontend-engineer
  - module-executor
when: A brief asks for a workflow, pipeline, canvas node, workflow action, or a module feature that starts a workflow.
---

# Build and integrate an agentic workflow

`workflows.core` owns durable directed acyclic workflows. A workflow coordinates
pinned agent revisions, deterministic gates, schema validators, registered
module actions, data mappings, and terminal output. It does not own schedules or
webhook secrets. Those remain optional concerns of `automations.core`.

Read `docs/adr/0006-agentic-workflows.md`, the approved
`modules/workflows/spec/module.yaml`, and the contracts in
`modules/workflows/src/domain/types.ts` before changing a workflow surface.

## Pick the correct extension point

- A workflow definition belongs in `workflows.core` and is edited through its
  API or canvas. Do not hardcode a tenant workflow in source.
- A business operation that a workflow may call is a versioned agent action.
  Register it through the agents action catalog. Follow `agent-tool-design` for
  permission, input, output, timeout, idempotency, and audit rules.
- A business module that starts a workflow resolves
  `workflows.execution.v1` from `context.capabilities`. It never imports a
  workflow repository or database.
- A schedule or signed webhook remains in `automations.core`. Its optional
  bridge invokes the workflow capability with a service actor and a separate
  schedule or webhook origin.
- If the workflow module is absent, the capability registry returns `null`.
  Hide an optional feature or return a clear stable refusal.

## Graph contract

Version one is a bounded DAG. The graph contains:

- `input`: accepts the invocation envelope.
- `agent`: calls one exact immutable agent revision and validates structured
  output.
- `agent-decision`: produces one schema-valid `pass` or `fail` outcome.
- `gate`: evaluates the versioned allowlisted logic language.
- `validator`: validates an envelope against a pinned JSON schema.
- `action`: calls one exact registered action contract version.
- `merge`: waits for all declared incoming paths.
- `output`: settles the workflow with a typed result.

Every port names a schema. Every edge connects compatible ports. Mappings are
declarative literals, JSON pointer paths, or templates with explicit variable
bindings. Never add JavaScript, dynamic imports, shell commands, downloaded
code, arbitrary expressions, or hidden provider decisions to graph data.

The hard limits live in `WORKFLOW_LIMITS` in
`modules/workflows/src/domain/types.ts`. Validation must reject a cycle,
dangling edge, unreachable node, missing terminal output, incompatible port,
missing exact dependency, oversized graph, or unsupported action risk before
publication.

## Revisions and publication

Draft saves use optimistic concurrency through `expectedRevision`. A successful
save creates the next draft revision. A conflict never overwrites another
editor.

Publication:

1. Validates and compiles the graph.
2. Resolves exact agent revisions and exact action contract versions.
3. Rejects missing, archived, incompatible, external, or destructive
   dependencies.
4. Stores an immutable content-addressed published revision.
5. Leaves earlier revisions and their run evidence unchanged.

Never replace a pinned dependency with its latest version during execution.
Editing after publication creates another draft.

## Execution modes

Use the smallest mode that proves the change:

- Dry-run validates a draft and returns issues, compiled order, references,
  permissions, checksum, and limits. It creates no run and invokes nothing.
- Simulation persists a run history but uses fixtures for nondeterministic
  nodes. It advances virtual time without sleeping and never calls a provider,
  action, or business mutation.
- Live runs only published revisions. It may call pinned agents and approved
  read or workspace-write actions under the initiating permission snapshot.

Do not disguise simulation as live execution. Do not use live mode to test an
invalid draft.

## Invoke a published workflow from a module

Resolve the capability at request or service call time, after platform
composition has completed:

```ts
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from '@coreloom/module-workflows/server';

const workflows = context.capabilities.get<WorkflowExecutionCapability>(
	WORKFLOW_EXECUTION_CAPABILITY,
);
if (!workflows) throw new ModuleError('WORKFLOWS_UNAVAILABLE');

const accepted = await workflows.enqueue(
	{
		workflowKey: 'catalog-enrichment',
		input: { itemId },
		idempotencyKey: `catalog:${itemId}:${version}`,
	},
	{
		tenantId,
		actor,
		origin: {
			kind: 'module',
			moduleId: 'catalog.core',
			operationId: 'catalog.enrichment.start',
		},
		permissionSnapshot,
	},
);
```

The module manifest declares `workflows.core` only when workflow support is a
required feature. An optional integration belongs in a small bridge module that
depends on both sides. Do not duplicate the capability interface locally to
avoid a dependency declaration.

Trusted context and business input are separate. Tenant, actor, origin, and
permission snapshot never come from the request body. The idempotency key is
stable for one logical operation. Reusing it with different input is a
conflict, not a second run.

## Actor and permission rules

- A user action uses the real user actor.
- A tool invoked by an agent uses the real agent actor and child run
  correlation supplied by `AgentToolContext`.
- A schedule or webhook uses a service actor whose `configuredBy` is the real
  user who configured it. Origin stays `schedule` or `webhook`.
- A workflow definition grants no scope. Live execution intersects the caller
  snapshot with each node's agent or action requirements.
- A cross-tenant id, foreign cursor, missing scope, absent dependency, or
  mismatched action version is refused before data or provider work.

## History, recovery, and cancellation

The browser observes execution. It never owns execution. Enqueue persists the
run before returning. Workers use leases and recover expired work from stored
node state, child ids, and stable side-effect idempotency keys.

Every transition appends an ordered schema-versioned event. Run, node,
attempt, and edge states are separate projections. `pass` and `fail` are normal
outcome ports, not technical statuses.

Cancellation is durable and cooperative. It prevents new nodes, asks the
current child agent or action to cancel, records whether it acknowledged, and
ignores late output for routing while keeping its safe evidence.

History responses contain redacted bounded evidence. They never expose provider
credentials, session tokens, hidden reasoning, encrypted payload blobs, or
unrestricted request bodies.

## Required tests

For a graph or runtime change, prove:

1. Deterministic compile order and rejection of cycles, dangling edges,
   incompatible ports, unreachable nodes, and missing output.
2. Tenant isolation plus one unauthenticated and one unscoped refusal for every
   endpoint group.
3. Exact agent and action revision refusal with no latest-version fallback.
4. Dry-run produces no run, provider call, action call, or business write.
5. Simulation uses fixtures and virtual duration with no real wait.
6. Live enqueue is idempotent and persists before acceptance.
7. Recovery before and after child enqueue does not duplicate work.
8. Retry records the chosen delay before waiting and reuses the side-effect
   idempotency key.
9. Cancellation prevents downstream work and records late results safely.
10. Event replay, cursor binding, payload redaction, retention, usage, cost,
    and audit hash-chain integrity.
11. The canvas shows validation, loading, empty, error, denied, simulation,
    live, cancelled, and recovered states, including small-screen read mode.

Run the module typecheck and tests, `pnpm coreloom module validate`, then the
full `pnpm verify`. For a new module integration, update its approved spec and
move `specVersion`, `module.json` version, and package version together.
