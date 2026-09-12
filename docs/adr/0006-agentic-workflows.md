# ADR 0006: Durable agentic workflows

- Status: proposed
- Date: 2026-09-02
- Decision owner: workflows.core

## Context

Flowdular can execute one durable agent run and can trigger an agent from
`automations.core`. It cannot describe, publish, inspect, or recover a business
process that coordinates several pinned agents, deterministic decisions,
validated data, and module actions.

The requested product is a visual workflow builder similar in interaction to
an automation canvas. A workflow passes typed data through connected nodes,
shows the path taken, and can be called from another module. The engine must
remain inside the same tenant, permission, audit, idempotency, and durability
boundaries as direct agent execution.

This ADR defines the contract before implementation. The companion module spec
is `modules/workflows/spec/module.yaml` and remains `draft`.

## Challenge verdict

### Strongest case for the feature

The platform already has concrete consumers:

1. A business module needs to run a repeatable multi-agent process without
   copying orchestration logic into its service.
2. `automations.core` needs a future target richer than one agent while keeping
   schedule and webhook ownership outside the workflow engine.
3. An operator needs to inspect one execution across several child agents,
   deterministic gates, validation, and business actions.
4. Agents and modules need one published, versioned callable artifact instead
   of prompt conventions that exist only in one screen.

Doing nothing leaves every consumer to invent its own queue, state machine,
recovery, audit, data mapping, and visual history. The problem is real and is
not solved by the current `agents.run-queue` capability.

### Attacks on the proposal

- **Necessity:** A simple sequence of agents could be hardcoded in each module.
  That works for one flow, but it immediately duplicates recovery, audit, and
  versioning. The second named consumer, automations, proves a shared seam is
  needed.
- **Placement:** Putting graphs in `agents.core` would make every agent install
  pay for a canvas, workflow database, and workflow worker. Putting them in
  `automations.core` would incorrectly make clocks and webhooks prerequisites
  for manual and module-invoked workflows. A separate optional module is the
  owning layer.
- **Cost:** Validation is `O(V + E)` in time and space for `V` nodes and `E`
  edges. A live run stores `O(V + E + A)` evidence, where `A` is total attempts.
  When the module is absent, consumers pay one capability lookup and no worker,
  timer, table, or client bundle cost.
- **Failure blast radius:** A duplicate action or a scope bypass can mutate
  business data. The engine therefore admits only versioned registered actions,
  requires idempotency, and cannot execute arbitrary code.
- **Reversibility:** Published graph JSON, node identifiers, action versions,
  and run evidence are durable formats. They are one-way contracts. Version one
  is deliberately smaller than a general process language.
- **Consistency:** The design follows the capability registry, agent run
  leases, immutable permission snapshots, variable templates, module migration
  ledger, actor model, and module-local audit pattern already in the repository.

### Decision

Build the simpler alternative: an optional `workflows.core` module with a
versioned DAG engine. Version one has no graph cycles, arbitrary JavaScript,
dynamic code, arbitrary HTTP nodes, sub-workflow nodes, or parallel scheduling
guarantee.

The strongest surviving objection is that the current agent contract cannot
execute an exact historical agent revision, and the current registered tool
contract has no version or workflow-safe idempotency contract. Those are hard
prerequisites. Live publication must remain unavailable until `agents.core`
provides them. The canvas, validation, dry-run, and fixture simulation can land
first without weakening that refusal.

A spike changes this verdict only if it proves all three cases:

1. Recovery after process loss between an agent enqueue and node settlement
   produces one child run.
2. Recovery after process loss around an action produces one business mutation.
3. A 100-node, 200-edge graph validates, simulates, pages its history, and
   resumes its stream within the declared limits.

## Module boundary

`workflows.core` owns:

- workflow identities and lifecycle;
- mutable drafts and immutable published revisions;
- graph schemas, mappings, layout, and compiled plans;
- durable workflow and node execution state;
- edge transfer evidence and ordered workflow events;
- workflow-local audit evidence and run history;
- safe redacted payload snapshots and cost aggregation.

It does not own:

- agent definitions, providers, child agent runs, or model pricing;
- module business records or repositories;
- schedules, webhook definitions, trigger secrets, or a polling clock;
- user accounts, sessions, memberships, or source permissions;
- arbitrary connectors, shell execution, or downloaded code.

`workflows.core` depends on `agents.core`. It calls agents and registered actions
only through public capabilities. It never reads the agents database.

`automations.core` remains optional and separate. The workflow module never
starts an automation clock. A later small integration module can depend on
both modules and expose workflow targets to schedules and webhooks without
making either base module own the other.

## Concrete consumers and call sites

### A business module invokes a published workflow

A module that requires workflow support declares `workflows.core` as a module
dependency and imports the public server contract. It gets the capability
inside a protected endpoint or service that already has a trusted principal.

```ts
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from '@flowdular/module-workflows/server';
import { userActor } from '@flowdular/kernel';

const workflows = context.capabilities.get<WorkflowExecutionCapability>(
	WORKFLOW_EXECUTION_CAPABILITY,
);
if (!workflows) {
	throw new ExpenseServiceError(
		'WORKFLOWS_UNAVAILABLE',
		'Workflow execution is not available.',
		503,
	);
}

const accepted = await workflows.enqueue(
	{
		workflowKey: 'expenses.review',
		input: { claimId: claim.id, amount: claim.amountMinor },
		idempotencyKey: `expense-review:${claim.id}:${claim.version}`,
	},
	{
		tenantId: principal.tenantId,
		actor: userActor({
			accountId: principal.accountId,
			displayName: principal.displayName,
			email: principal.email,
		}),
		origin: {
			kind: 'module',
			moduleId: 'expenses.core',
			operationId: 'expenses.claims.submit',
		},
		permissionSnapshot: [...principal.scopes],
	},
);
```

The input does not carry a tenant, actor, scopes, mode, revision, action grants,
or tool grants. Those values come from trusted server context and the published
workflow revision.

### An agent invokes a module endpoint that starts a workflow

The target module registers a normal agent tool for the endpoint. The tool
passes `agentActor` built from the trusted tool context and uses the same
workflow capability. The resulting workflow history names both the agent and
the authorizing agent run.

```ts
const actor = agentActor({
	runId: toolContext.runId,
	agentId: toolContext.agentId,
	agentName: toolContext.agentName,
});

await workflows.enqueue(request, {
	tenantId: toolContext.tenantId,
	actor,
	origin: {
		kind: 'module',
		moduleId: 'catalog.core',
		operationId: 'catalog.enrichment.start',
	},
	permissionSnapshot: [...toolContext.permissions],
});
```

The current `AgentToolContext` exposes the run but not the agent identity. Stage
0 adds `agentId` and `agentName` from the immutable child run snapshot. Until
then a tool cannot truthfully produce the desired agent actor and must not
substitute the run id as if it were an agent identity.

### Automations triggers a workflow

Version one keeps the coupling inside `automations.core`: it declares
`workflows.core` as a dependency, registers a workflow target adapter in its own
target registry, and maps a schedule or signed webhook to the execution
capability. The adapter resolves the capability per call, so a workspace may
still leave `workflows.core` uninstalled.

```ts
await workflows.enqueue(
	{
		workflowKey: target.workflowKey,
		input: triggerPayload,
		idempotencyKey: `automation:${trigger.id}:${slotOrSignature}`,
	},
	{
		tenantId: trigger.tenantId,
		actor: serviceActor({
			serviceId: 'automations.core',
			label: 'Automations',
			configuredBy: trigger.configuredBy,
		}),
		origin: { kind: 'webhook', triggerId: trigger.id },
		permissionSnapshot: trigger.permissionSnapshot,
	},
);
```

The schedule or webhook reference stays in `origin`. It is not disguised as a
user identifier or an anonymous `system` actor.

## Public execution capability

The first public surface is experimental in 0.1. It is module-owned and exported
from `@flowdular/module-workflows/server`.

```ts
export const WORKFLOW_EXECUTION_CAPABILITY = 'workflows.execution.v1';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type WorkflowExecutionOrigin =
	| { readonly kind: 'manual' }
	| {
			readonly kind: 'module';
			readonly moduleId: string;
			readonly operationId: string;
	  }
	| { readonly kind: 'schedule'; readonly scheduleId: string }
	| { readonly kind: 'webhook'; readonly triggerId: string };

export interface WorkflowInvocationContext {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly origin: WorkflowExecutionOrigin;
	readonly permissionSnapshot: readonly string[];
}

export interface WorkflowCapabilityContext {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly permissionSnapshot: readonly string[];
}

export interface WorkflowEnqueueRequest {
	readonly workflowKey: string;
	readonly input: JsonValue;
	readonly idempotencyKey: string;
}

export interface WorkflowRunAccepted {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: number;
	readonly status: 'queued';
	readonly created: boolean;
}

export interface WorkflowExecutionCapability {
	listPublished(
		context: WorkflowCapabilityContext,
	): readonly WorkflowPublishedReference[];

	enqueue(
		request: WorkflowEnqueueRequest,
		context: WorkflowInvocationContext,
	): Promise<WorkflowRunAccepted>;

	getRun(
		runId: string,
		context: WorkflowCapabilityContext,
	): WorkflowRunSummary | null;

	cancel(
		runId: string,
		context: WorkflowCapabilityContext,
	): WorkflowCancellationResult;
}
```

### Capability lifecycle

- The workflow composition registers the capability once.
- A duplicate capability identifier stops platform boot.
- Calls before every composition has completed are unsupported. Consumers call
  it only from routes, services, tools, or a composition `start` callback.
- If the module is absent, `get` returns `null`. A consumer must refuse clearly
  or hide its optional workflow feature.
- `listPublished`, `getRun`, and `cancel` receive trusted actor and permission
  context and enforce `definitions.read`, `runs.read`, and `runs.cancel`
  respectively. A tenant identifier alone is never read authority.
- Enqueue commits the durable run before resolving.
- Reusing the same tenant and idempotency key returns the original run with
  `created: false` when the workflow key and input hash match. A mismatch is a
  stable `WORKFLOW_IDEMPOTENCY_CONFLICT` refusal.
- A capability reference is valid only during the composed platform lifetime.
  Use after teardown is a programmer error and never silently queues work.
- Re-entrant calls from a workflow action back into workflow execution are
  refused in version one. A future lineage contract may add bounded subflows.

### Capability misuse resistance

- `tenantId`, actor, origin, and permissions are a separate trusted context,
  not fields in user input.
- Every read, list, enqueue, and cancel operation rechecks the permission needed
  for that operation against the trusted snapshot. Resolving the capability is
  not authorization.
- The caller cannot choose `mode`. Module calls are live. Dry-run and simulation
  use dedicated editor endpoints.
- The caller cannot choose a draft or historical workflow revision. The server
  snapshots the current published revision atomically at enqueue.
- The idempotency key is required, bounded, and namespaced by the caller.
- Definitions cannot add scopes, action grants, or tool grants.
- Inputs are JSON only, bounded before persistence, and checked against the
  published workflow input schema.

## Required agent and action capabilities

The current `agents.run-queue` contract can only list current agents and enqueue
the current revision. It cannot observe or cancel a child through that public
surface. `agents.core` stores the current definition and places an executable
snapshot on each run, but it does not retain reusable historical agent
definitions. A workflow therefore cannot execute revision 3 after an agent has
moved to revision 4. `AgentRun.output` is free-form text and the public enqueue
contract cannot require a structured output schema.

The current `AgentTool` contract also has no `contractVersion`, `outputSchema`,
or idempotency capability metadata, and there is no public direct tool executor.
That is not enough for a published workflow action.

Before live workflow publication is enabled, `agents.core` must add public
capabilities with these properties:

```ts
export interface AgentRevisionReference {
	readonly agentId: string;
	readonly revision: number;
	readonly name: string;
	readonly status: 'active' | 'paused' | 'archived';
}

export interface AgentChildCapabilityContext {
	readonly tenantId: string;
	readonly workflowRunId: string;
	readonly actor: Actor;
	readonly permissionSnapshot: readonly string[];
}

export interface AgentRevisionExecutionCapability {
	getRevision(
		agentId: string,
		revision: number,
		context: AgentChildCapabilityContext,
	): AgentRevisionReference | null;

	enqueueRevision(
		request: {
			readonly agentId: string;
			readonly revision: number;
			readonly input: string;
			readonly outputContract:
				| { readonly kind: 'text' }
				| {
						readonly kind: 'json-schema';
						readonly name: string;
						readonly schema: Readonly<Record<string, unknown>>;
				  };
			readonly idempotencyKey: string;
		},
		context: AgentChildCapabilityContext,
	): Promise<{ readonly runId: string; readonly created: boolean }>;

	readEvents(
		runId: string,
		afterSequence: number,
		context: AgentChildCapabilityContext,
	): readonly AgentExecutionEvent[];

	getResult(
		runId: string,
		context: AgentChildCapabilityContext,
	): AgentRunResult | null;
	requestCancel(runId: string, context: AgentChildCapabilityContext): boolean;
}
```

An exact revision must remain executable after a newer revision is published.
`agents.core` owns a new immutable `agent_definition_revisions` store, or an
equivalent content-addressed executable snapshot store, and exact-revision
enqueue reads only that store. Existing run snapshots remain evidence and do
not become a hidden revision catalog.

Every exact-revision catalog, observation, result, and cancellation call carries
the persisted trusted workflow child context. A bare tenant identifier never
authorizes access to an agent definition or child run.

`agents.core` and `@flowdular/harness` also own structured output support. An
agent-decision node supplies a JSON Schema output contract to exact-revision
enqueue and receives parsed, schema-valid JSON. It never branches by parsing or
guessing from free-form `AgentRun.output`. Publication refuses a decision node
when its pinned agent model cannot honor the structured output contract.

Action nodes reuse module actions already shaped as agent tools instead of
creating a second parallel business-operation registry. The action descriptor
must become a versioned shared contract:

```ts
export interface VersionedActionDescriptor {
	readonly id: string;
	readonly contractVersion: number;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema: Readonly<Record<string, unknown>>;
	readonly timeoutMs: number;
	readonly idempotency: 'required';
	readonly risk: 'read' | 'workspace-write';
	readonly cancellation: 'cooperative' | 'not-supported';
}

export interface ActionCancellationResult {
	readonly actionInvocationId: string;
	readonly state: 'acknowledged' | 'not-acknowledged' | 'not-supported';
}

export interface ActionInvocationAccepted {
	readonly actionInvocationId: string;
	readonly created: boolean;
}

export interface ActionExecutionResult {
	readonly actionInvocationId: string;
	readonly status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
	readonly output?: JsonValue;
	readonly code?: string;
}

export interface AgentActionExecutionCapability {
	listWorkflowActions(): readonly VersionedActionDescriptor[];
	start(
		request: {
			readonly actionId: string;
			readonly contractVersion: number;
			readonly input: JsonValue;
			readonly idempotencyKey: string;
		},
		context: {
			readonly workflowRunId: string;
			readonly nodeRunId: string;
			readonly tenantId: string;
			readonly actor: Actor;
			readonly permissionSnapshot: readonly string[];
			readonly signal: AbortSignal;
		},
	): Promise<ActionInvocationAccepted>;
	getResult(
		actionInvocationId: string,
		context: AgentChildCapabilityContext,
	): ActionExecutionResult | null;
	requestCancel(
		actionInvocationId: string,
		context: AgentChildCapabilityContext,
	): ActionCancellationResult;
}
```

The executor validates input, permissions, version, timeout, output, and
idempotency before and around the module service call. Acceptance returns or
persists a stable action invocation identifier before effectful work can be
lost to recovery. The workflow stores the action identifier and safe result
evidence. An executor that declares cooperative cancellation passes the signal
to the action and reports acknowledgement. An executor that cannot cancel still
supports result observation by invocation identifier. The target module remains
the owner of its business mutation and record history.

The underlying agent tool catalog may still contain `external` and
`destructive` tools. `agents.actions.v1` excludes them from
`listWorkflowActions` and refuses them by identifier during `invoke`. Version
one has no approval node, approval receipt, or approver identity in its enqueue
contract, so confirmation copy in the canvas is not sufficient authority. A
later spec must define durable human approval before either risk can enter a
workflow.

These additions are backward compatible:

- `agents.run-queue` remains unchanged for `automations.core` and existing
  callers;
- `agents.core` registers a new `agents.run-execution.v2` capability for exact
  revision enqueue, structured output, observation, and cancellation;
- `AgentTool` gains optional action metadata, so existing agent-only tools keep
  working unchanged;
- `agents.core` exposes only tools with complete version, input, output, risk,
  and idempotency metadata through a new `agents.actions.v1` capability;
- `agents.actions.v1` exposes only `read` and `workspace-write` actions to
  workflows and refuses `external` or `destructive` actions even when such a
  tool is available to a direct agent run;
- `@flowdular/harness` owns schema validation, timeout, output bounds, and the
  shared invocation guard, while the registering business module owns the
  service operation and idempotent effect;
- `workflows.core` consumes these capabilities and owns workflow recovery and
  workflow evidence. It does not reach into their repositories.

## Actor and origin model

The kernel `Actor` currently supports `user` and `agent`. Scheduled and webhook
workflow runs also need a truthful actor. Synthetic actor strings such as
`system` or `schedule:<id>` erase who configured the authority and make record
history inconsistent.

The kernel actor contract should gain a service variant because business
modules, workflow history, agent tools, and record history all need the same
meaning:

```ts
export interface ServiceActor {
	readonly kind: 'service';
	readonly id: string;
	readonly label: string;
	readonly configuredBy: UserActor;
}

export type Actor = UserActor | AgentActor | ServiceActor;
```

Execution origin stays separate:

- manual calls carry the real user actor;
- module calls carry the user or agent that caused the module operation;
- schedules carry the `automations.core` service actor plus the user who last
  configured the schedule, with `origin.kind = 'schedule'` and `scheduleId`;
- webhooks carry the service actor plus configuring user, with
  `origin.kind = 'webhook'` and `triggerId`.

`workflows.core` must not define a private actor union. A module action can
change a business record, and its owner must be able to append the same actor to
the shared record-history contract. The kernel extension is therefore the
correct layer.

## Graph document

Every draft and published revision stores a versioned graph document. Canvas
coordinates are retained for editing but excluded from execution ordering.

```ts
export interface WorkflowGraphV1 {
	readonly schemaVersion: 1;
	readonly nodes: readonly WorkflowNodeV1[];
	readonly edges: readonly WorkflowEdgeV1[];
	readonly schemas: Readonly<Record<string, JsonSchemaV1>>;
	readonly layout: Readonly<
		Record<string, { readonly x: number; readonly y: number }>
	>;
}

export interface WorkflowEdgeV1 {
	readonly id: string;
	readonly source: { readonly nodeId: string; readonly port: string };
	readonly target: { readonly nodeId: string; readonly port: string };
	readonly label?: string;
}

export type WorkflowNodeV1 =
	| WorkflowInputNodeV1
	| WorkflowAgentNodeV1
	| WorkflowAgentDecisionNodeV1
	| WorkflowGateNodeV1
	| WorkflowValidatorNodeV1
	| WorkflowActionNodeV1
	| WorkflowMergeNodeV1
	| WorkflowOutputNodeV1;
```

Identifiers are lowercase dot-separated values and remain stable within one
workflow identity. A copied node receives a new identifier. Renaming a label
does not change its identifier.

### Ports

Each node type owns fixed semantic ports. Every port names a schema from the
graph schema map.

| Node type        | Input ports | Output ports              | Purpose                                                                            |
| ---------------- | ----------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `input`          | none        | `data`                    | Validate and emit invocation input. Exactly one per graph.                         |
| `agent`          | `input`     | `success`, `failure`      | Execute one pinned agent revision and expose structured result or bounded failure. |
| `agent-decision` | `input`     | `pass`, `fail`, `failure` | Execute a pinned agent revision whose response must match a pass or fail schema.   |
| `gate`           | `input`     | `pass`, `fail`            | Evaluate deterministic allowlisted logic and forward the unchanged input.          |
| `validator`      | `input`     | `pass`, `fail`            | Validate against a pinned graph schema and emit data or path-addressed errors.     |
| `action`         | `input`     | `success`, `failure`      | Invoke one pinned action contract with a stable idempotency key.                   |
| `merge`          | `items`     | `data`                    | Collect all reachable incoming envelopes in edge identifier order.                 |
| `output`         | `input`     | none                      | Validate one terminal workflow result. At least one per graph.                     |

An output port may fan out to several edges. A normal input port accepts one
edge. The merge `items` port accepts several. Version one merge mode is `all`.
It waits until every reachable incoming edge emitted or closed, then emits the
received envelopes in stable edge identifier order. There is no timing-based
`first` or `race` mode.

### Node references

Published nodes contain immutable references:

```ts
export interface PinnedAgentReference {
	readonly agentId: string;
	readonly revision: number;
}

export interface PinnedActionReference {
	readonly actionId: string;
	readonly contractVersion: number;
}
```

Agent publication resolves and pins the exact revision. Action publication
resolves and pins the exact contract version. A live preflight verifies both
still exist. It never substitutes the latest agent or action.

### Data mappings

Mappings are data, not code. Each target field uses one of three bindings:

```ts
export type WorkflowBindingV1 =
	| { readonly kind: 'literal'; readonly value: JsonValue }
	| {
			readonly kind: 'path';
			readonly sourceNodeId: string;
			readonly sourcePort: string;
			readonly pointer: string;
	  }
	| {
			readonly kind: 'template';
			readonly template: string;
			readonly variables: readonly WorkflowTemplateVariableV1[];
	  };

export interface WorkflowTargetMappingV1 {
	readonly targetPointer: string;
	readonly binding: WorkflowBindingV1;
}
```

- A literal is immutable JSON.
- A path is an RFC 6901 JSON Pointer into an upstream port envelope.
- A template uses the existing single-pass `{{ variable }}` contract and
  always produces a string. Its variables are explicit path bindings or
  permission-filtered platform variable definitions.
- A value emitted by a template is not rescanned for more tokens.
- There is no JavaScript, `eval`, function body, expression language inside a
  mapping, implicit environment lookup, or property access outside a pointer.

The compiler catches obvious source and target schema incompatibility. Runtime
validation remains authoritative because general JSON Schema assignability is
not guaranteed to be decidable by the editor.

### Gate logic

Gate expressions use a versioned allowlist with literal values, JSON Pointer
reads, `and`, `or`, `not`, equality, ordered numeric comparison, membership,
and existence. Missing paths produce a stable gate error, not JavaScript-like
truthiness. Strings never coerce to numbers or booleans.

An agent-based judgment is never embedded in this language. It uses an
`agent-decision` node whose output schema is:

```ts
interface AgentDecisionResult {
	readonly decision: 'pass' | 'fail';
	readonly data: JsonValue;
	readonly reason?: string;
}
```

Free-form output, another decision string, or schema-invalid data enters the
node failure policy. The engine does not guess a branch from prose.

## Graph validation and publication

Validation is pure and runs in `O(V + E)` time and space. It reports stable
issues addressed by node, edge, port, mapping, or schema identifier.

Publication requires all of the following:

1. Exactly one input node and at least one output node.
2. Unique node, edge, port, and schema identifiers.
3. No cycle.
4. Every node is reachable from input.
5. Every reachable terminal path reaches an output or an explicit handled
   failure output.
6. Every edge connects an existing compatible output and input port.
7. Every required input has the allowed number of incoming edges.
8. Every path mapping reads an upstream node, never a future or unrelated node.
9. Every template variable exists and is allowed by the publishing principal.
10. Every gate operation belongs to logic language version one.
11. Every schema belongs to the supported JSON Schema subset and stays within
    depth and size limits.
12. Every agent reference resolves to an exact retained active revision.
13. Every action resolves to an exact contract version, requires idempotency,
    and has `read` or `workspace-write` risk.
14. The graph and its compiled plan stay within all limits.

The canonical semantic graph is serialized with stable key order and hashed.
Layout may be changed in a new draft without changing execution meaning, but a
published revision stores both the semantic checksum and its layout snapshot.

## Deterministic execution semantics

### Compiled plan

Publication compiles a stable topological order. Node identifier is the final
tie breaker. The compiled plan and compiler version are stored with the
published revision.

Version one runs one ready node at a time. It may gain parallel execution in a
future engine version, but consumers cannot rely on current wall-clock overlap.

### Edge state

When a node settles, each outgoing edge becomes one of:

- `emitted`, with schema id, payload hash, byte size, safe preview, source
  attempt, outcome port, and `settledAt`;
- `closed`, because the source chose another outcome port, with the selected
  port, stable close reason, source attempt, and `settledAt`;
- `skipped`, because the source node was unreachable or cancelled, with a
  stable skip reason and `settledAt`.

Every edge has one immutable settlement. The settlement record names source
node, source attempt when one existed, target node and target port. Empty or
retained-away data is represented by typed evidence state rather than by moving
or omitting the edge row.

A downstream node becomes ready when every required incoming edge has emitted,
or when its merge semantics prove the remaining edges closed. If a required
edge closes, that node is skipped and its outgoing edges close recursively.

Each node runs at most once successfully. Retry attempts do not emit edge data
until one attempt succeeds or the retry policy settles to failure.

### Node failure policy

Every executable node declares one policy:

```ts
interface WorkflowNodeFailurePolicyV1 {
	readonly maxAttempts: number;
	readonly retryOn: readonly string[];
	readonly backoff: {
		readonly kind: 'fixed' | 'exponential';
		readonly initialMs: number;
		readonly maximumMs: number;
	};
	readonly onExhausted: 'emit-failure' | 'fail-run';
}
```

Bounds are part of the graph schema. Permanent refusals, permission failures,
schema failures, missing versions, and idempotency conflicts are never
retryable.

Agent and action idempotency keys derive from tenant, workflow run, node,
published revision, and the semantic attempt group. Recovery reuses the same
key. A retry of a provider failure may create a new agent attempt only when the
agents capability confirms the prior idempotent enqueue reached a terminal
retryable result.

### Durable retry schedule

The attempt that fails records a stable error code and one classification:
`retryable` or `permanent`. When policy allows another attempt, the same
transaction appends `node.retry.scheduled` with:

- node id and completed attempt number;
- semantic attempt group id and unchanged side-effect idempotency key;
- matched `retryOn` code and retry classification;
- selected backoff in milliseconds;
- absolute `nextAttemptAt` for live execution;
- virtual next-attempt offset for simulation.

The node projection becomes `waiting-retry`. A worker starts the next immutable
attempt only after the stored time and appends `node.retry.started`. Recovery
uses the recorded time and delay. It never recomputes jitter or backoff. Version
one applies no random jitter, which keeps replay and recovery deterministic.
Permanent failures and refusals never produce `node.retry.scheduled`.

## Execution modes

### Dry-run

Dry-run accepts a draft graph and sample input. It validates, resolves
references, checks the caller's current permissions, compiles the plan, and
returns issues plus the plan summary.

```ts
export interface WorkflowValidationIssueV1 {
	readonly code: string;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly location:
		| { readonly kind: 'graph' }
		| { readonly kind: 'node'; readonly nodeId: string; readonly path?: string }
		| {
				readonly kind: 'edge';
				readonly edgeId: string;
				readonly path?: string;
		  };
}

export interface WorkflowDryRunResponseV1 {
	readonly reportVersion: 1;
	readonly graphChecksum: string;
	readonly valid: boolean;
	readonly issues: readonly WorkflowValidationIssueV1[];
	readonly compiledOrder: readonly string[];
	readonly references: readonly {
		readonly kind: 'agent' | 'action' | 'schema';
		readonly id: string;
		readonly version: string;
		readonly available: boolean;
	}[];
	readonly requiredPermissions: readonly string[];
	readonly limits: Readonly<Record<string, number>>;
}
```

It guarantees:

- no workflow run row;
- no run id, invocation history, node attempt, edge transfer, run event,
  payload row, usage rollup, cost rollup, or workflow audit evidence;
- no provider or agent run;
- no registered action call;
- no business data write;
- no audit event other than normal request security logging;
- no secret resolution.

### Simulation

Simulation accepts a draft or published graph, sample input, and bounded node
fixtures. Agent, agent-decision, and action nodes require fixtures. Gate,
validator, merge, input, output, and mappings execute for real against fixture
data.

Each fixture may declare `simulatedDurationMs`. The engine creates virtual
timestamps and a deterministic event plan. It does not sleep. The client may
animate the plan at a selected playback speed.

Simulation persists a run marked `simulate` so it appears in history with its
actor, revision or draft checksum, node data, and event path. It never calls a
provider, action, outbound network, or business repository.

Each simulation event stores the wall-clock `recordedAt` at which evidence was
persisted plus `virtualOffsetMs` from the simulation start. It has no fabricated
wall-clock `occurredAt`. Ordering is still the durable run sequence. Simulation
usage and cost rollups use `state: 'not-applicable'`, zero counters, no pricing
snapshot, and no child or action correlation. Fixture provenance is retained as
a safe fixture hash, never as provider usage.

### Live

Live mode accepts only a published revision. It performs a fresh preflight,
persists the run, and may call exact agent revisions plus registered `read` or
`workspace-write` actions.

The canvas labels this action `Run live`, not `Test`, because it may produce
real provider cost and business side effects. External and destructive actions
are unavailable in version one because the workflow contract has no durable
human approval receipt.

## Durable execution and recovery

A live invocation commits before returning:

- workflow run id, tenant, workflow id, key, and published revision;
- semantic graph checksum and compiler version;
- actor and separate origin;
- permission snapshot and digest;
- mode, input hash, safe input reference, limits, and idempotency key;
- `queued` status and first ordered event.

The workflow worker claims a run with an expiring lease. It renews the lease
while it owns the run. Node intent is committed before a child agent or action
is called. Child id and idempotency key are committed as soon as the public
capability returns.

After a crash, a new worker reads the last node attempt:

- if no call was accepted, it repeats the call with the same key;
- if an agent child id exists, it observes that exact run;
- if an action accepted the key, it reads or repeats the same idempotent result;
- if evidence is inconsistent, it refuses recovery with
  `WORKFLOW_RECOVERY_INCONSISTENT` and never guesses.

The browser does not hold a lease and cannot stop recovery by disconnecting.

## Status model

### Event envelope and catalog

The append-only stream is the source of truth. Every durable event uses this
envelope and a payload schema fixed by `schemaVersion` plus `type`:

```ts
export type WorkflowRunEventTypeV1 =
	| 'run.queued'
	| 'run.claimed'
	| 'run.recovered'
	| 'node.ready'
	| 'node.attempt.started'
	| 'node.child.waiting'
	| 'node.attempt.settled'
	| 'node.retry.scheduled'
	| 'node.retry.started'
	| 'node.skipped'
	| 'edge.settled'
	| 'run.cancel.requested'
	| 'node.cancel.requested'
	| 'node.cancel.acknowledged'
	| 'node.cancel.not-acknowledged'
	| 'node.result.late-ignored'
	| 'payload.retention.applied'
	| 'run.succeeded'
	| 'run.failed'
	| 'run.refused'
	| 'run.cancelled';

export interface WorkflowRunEventV1 {
	readonly eventId: string;
	readonly schemaVersion: 1;
	readonly tenantId: string;
	readonly runId: string;
	readonly sequence: number;
	readonly type: WorkflowRunEventTypeV1;
	readonly recordedAt: number;
	readonly virtualOffsetMs?: number;
	readonly payload: Readonly<Record<string, JsonValue>>;
}
```

`sequence` starts at one and is contiguous within one tenant and run.
`recordedAt` is the evidence persistence time. Only simulation events carry
`virtualOffsetMs`. Unknown schema versions or event types stop projection repair
with `WORKFLOW_EVENT_SCHEMA_UNSUPPORTED`; they are never skipped or guessed.

| Event type                     | Required payload                                                                     | Projection effect                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `run.queued`                   | workflow revision or draft checksum, actor, origin, mode                             | Create `queued` run.                                                                  |
| `run.claimed`                  | worker id, lease expiry                                                              | `queued` or recovered wait becomes `running`.                                         |
| `run.recovered`                | prior lease, worker id, recovery reason                                              | Keep legal non-terminal state and record new ownership.                               |
| `node.ready`                   | node id                                                                              | Node becomes `ready`; run stays or becomes `running`.                                 |
| `node.attempt.started`         | node id, attempt, semantic group, input evidence                                     | Append one `running` attempt.                                                         |
| `node.child.waiting`           | node id, attempt, child kind and correlation id                                      | Attempt becomes `waiting-child`; run becomes `waiting-agent` only for an agent child. |
| `node.attempt.settled`         | node id, attempt, technical status, outcome port, evidence, error classification     | Make that attempt terminal and project the node result.                               |
| `node.retry.scheduled`         | node id, prior attempt, classification, backoff, next attempt time                   | Node and run become `waiting-retry`.                                                  |
| `node.retry.started`           | node id, next attempt, scheduled event sequence                                      | Return node and run to `running` before the next attempt starts.                      |
| `node.skipped`                 | node id, reason                                                                      | Node becomes terminal `skipped` without creating an attempt.                          |
| `edge.settled`                 | edge id, emitted, closed, or skipped state, source attempt, target, reason, evidence | Append one immutable edge settlement without changing run status.                     |
| `run.cancel.requested`         | requester, reason, requested time                                                    | Run becomes `cancel-requested` and no new node may start.                             |
| `node.cancel.requested`        | node id, attempt, child kind and correlation                                         | Record cooperative request without changing attempt terminal state.                   |
| `node.cancel.acknowledged`     | node id, attempt, child kind and correlation                                         | Record acknowledgement while the worker still observes terminal settlement.           |
| `node.cancel.not-acknowledged` | node id, attempt, child kind, reason                                                 | Record rejection, timeout, or unsupported cancellation.                               |
| `node.result.late-ignored`     | node id, attempt, child correlation, result hash and terminal status                 | Retain safe evidence but never emit an edge after cancellation.                       |
| `payload.retention.applied`    | payload id, hash, policy and prior evidence state                                    | Project its evidence state to `expired`.                                              |
| `run.succeeded`                | output evidence and final rollups                                                    | Terminal `succeeded`.                                                                 |
| `run.failed`                   | stable error and final rollups                                                       | Terminal `failed`.                                                                    |
| `run.refused`                  | stable refusal and final rollups                                                     | Terminal `refused`.                                                                   |
| `run.cancelled`                | acknowledgement summary and final rollups                                            | Terminal `cancelled`.                                                                 |

### Workflow run projection

Intermediate statuses are `queued`, `running`, `waiting-agent`,
`waiting-retry`, and `cancel-requested`. Terminal statuses are `succeeded`,
`failed`, `refused`, and `cancelled`.

Legal transitions are:

- `queued` to `running`, `cancel-requested`, or `refused`;
- `running`, `waiting-agent`, and `waiting-retry` may move among each other as
  catalog events require, or move to `cancel-requested`, `succeeded`, `failed`,
  or `refused`;
- `cancel-requested` moves only to `cancelled` after in-flight work has been
  observed or bounded by its timeout;
- every terminal status is immutable.

`run.recovered` never widens these transitions. An illegal event transition
stops the worker and projection repair with
`WORKFLOW_EVENT_TRANSITION_INVALID`. Projection rows are caches that can be
rebuilt from sequence one without inventing an event.

### Node and attempt projection

A node execution projection has status `pending`, `ready`, `running`,
`waiting-child`, `waiting-retry`, `succeeded`, `failed`, `refused`, `skipped`,
or `cancelled`. Pending, ready, waiting-retry, and skipped are node states, not
attempt records.

An immutable attempt exists only after `node.attempt.started`. Its technical
status is `running`, `waiting-child`, `succeeded`, `failed`, `refused`, or
`cancelled`. A terminal attempt never changes. `pass` and `fail` are normal,
schema-bound outcome-port identifiers of a technically `succeeded` decision,
gate, or validator attempt. They are never attempt statuses and a fail outcome
does not by itself fail the run.

Every attempt records start, completion, duration, outcome port, retry
classification and decision, failure or refusal code, safe input and output
evidence, child run or action correlation, usage, cost, and event sequence
bounds. A retry appends a new attempt number. Cancellation or an unreachable
branch may terminate a node without fabricating an attempt.

## Full run history and evidence

Run history is tenant-scoped and cursor-paginated. It supports filters for:

- workflow id or key;
- exact workflow revision;
- actor kind and actor id;
- origin kind and origin reference;
- mode;
- intermediate or terminal status;
- queued and completed time range;
- child agent id;
- failure or refusal code.

Interactive ordering is fixed to `(queuedAt DESC, runId DESC)`. The first page
captures a high-water mark. Its opaque cursor has version `wfrc1` and is signed
by the server over tenant id, a canonical filter digest, the fixed sort, the
high-water mark, and the last `(queuedAt, runId)` pair. Later pages use the same
snapshot boundary, so newly queued runs do not shift or duplicate existing
rows. A cursor is valid only for the authenticated tenant and the exact filter
set that created it. Malformed, modified, foreign-tenant, stale-version, or
filter-mismatched cursors return `WORKFLOW_CURSOR_INVALID` or
`WORKFLOW_CURSOR_MISMATCH` and no rows.

Workflow audit pages use the same rule with `(sequence DESC)` and cursor version
`wfac1`. Run detail is not cursor-paged because contract limits bound it to at
most 100 nodes, 500 immutable attempts, and 200 edge settlements. The event
stream remains separately paged because it may contain 10,000 events.

The list row includes workflow, revision, actor, origin, mode, current status,
queued time, elapsed or final duration, node progress, child usage, priced cost,
unpriced child and action counts, and terminal failure summary.

Run detail includes:

- immutable invocation snapshot;
- published graph and compiled order;
- every node and attempt with status and duration;
- every edge emission, closure, and skip;
- safe redacted input and output previews;
- payload hashes, schemas, and byte sizes;
- child agent run ids and action invocation ids;
- aggregate usage and cost;
- cancellation request and acknowledgement;
- workflow audit event ids and target-module history correlation ids.

Each payload field uses `WorkflowPayloadEvidenceV1`, so an absent value, a JSON
`null`, a redacted value, and an expired value cannot be confused.

Provider credentials, session tokens, hidden reasoning, raw secret variables,
and unrestricted request bodies are never history data.

### Event stream and resume

Every run event has a run-local sequence and durable event id. SSE `id` is an
opaque run-bound resume cursor `wfre1` signed over tenant, run, and sequence. It
is not the database event id. The event data still includes `eventId`,
`schemaVersion`, and `sequence`.

A client reconnects with either HTTP `Last-Event-ID: <wfre1 cursor>` or an
integer `afterSequence`. If both are supplied they must name the same run and
sequence or the server returns `WORKFLOW_EVENT_CURSOR_CONFLICT`. A cursor for a
different tenant or run returns `WORKFLOW_EVENT_CURSOR_INVALID`. A sequence
beyond the durable tail returns `WORKFLOW_EVENT_CURSOR_AHEAD`.

The server replays at most 100 persisted events per connection. When more
remain, it emits a non-durable `workflow.replay-boundary` control event with
`nextAfterSequence` and `hasMore: true`, then closes. The client reconnects from
that sequence. Once caught up, persisted live events continue in order.
Heartbeat comments are emitted at most every 15 seconds, carry no SSE id, and
never advance a sequence. After a terminal run event is flushed, the server
emits a non-durable `workflow.stream-complete` control event naming the terminal
sequence and closes normally.

Reloading, filtering away the run, or closing the tab does not alter it. A
subscriber that falls behind receives a bounded replay page and reconnect
cursor instead of forcing the server to buffer without limit.

### Cancellation

Cancellation appends one idempotent `cancel-requested` event. The worker stops
scheduling new nodes and appends `node.cancel.requested` for each in-flight
child agent or action before calling its public cancellation capability.

An agent or cooperative action records `node.cancel.acknowledged` when it
accepts the request. Rejection, timeout, and `not-supported` record
`node.cancel.not-acknowledged` with a stable reason. In every case the worker
observes accepted work until terminal or until its already persisted timeout
settles it. An action that committed its idempotent effect before cancellation
keeps that target-module history. The workflow never claims compensation.

A child or action result arriving after `run.cancel.requested` is recorded as
`node.result.late-ignored` with correlation id, terminal status, output hash,
and redacted evidence state. Its output is never emitted to an edge and cannot
start another node. Once all in-flight work is terminal or timed out, the run
appends `run.cancelled`. It never transitions from cancel-requested to failed or
succeeded.

Calling cancel again returns the existing cancellation state. Cancelling a
terminal run changes nothing and returns its terminal status.

### Payload execution and evidence

Execution data and history evidence are different records:

- an execution payload is bounded JSON encrypted with authenticated encryption,
  a server-managed key id, and the shortest retention required for execution or
  recovery. It is available only to the owning worker and never returned by a
  history, event, stream, or audit API;
- an evidence preview is produced through scope filtering and redaction before
  persistence. It may contain bounded safe JSON and is the only payload shape
  exposed to readers.

```ts
export interface WorkflowPayloadEvidenceV1 {
	readonly version: 1;
	readonly state: 'available' | 'redacted' | 'truncated' | 'expired' | 'absent';
	readonly schemaId: string;
	readonly hash: string;
	readonly originalByteSize: number;
	readonly preview?: JsonValue;
	readonly reason?:
		| 'secret'
		| 'scope-denied'
		| 'size-limit'
		| 'retention'
		| 'not-emitted';
}
```

`available` with `preview: null` is a real JSON null. `absent` means no payload
was emitted. `redacted` and `truncated` retain hash, schema, and original size.
Retention changes only the preview state to `expired`; it never rewrites hashes
or pretends the prior value was null. A secret field may exist briefly only in
the encrypted execution payload. It never enters evidence, run events, SSE, or
audit metadata.

### Retention

Core evidence tables are append-only. Automated retention applies only to
separate payload blobs. Before a blob expires, the worker appends a
`payload-retention-applied` event with its hash and policy. It then deletes the
blob while keeping the run, status transitions, revisions, actor, origin,
attempts, edge hashes, durations, usage, cost, failures, and audit linkage.

The default metadata retention is indefinite in version one. A future deletion
policy requires a separate approved spec because removing audit evidence is a
compliance decision, not storage cleanup.

## Authorization and audit

Permissions are:

- `workflows.definitions.read`
- `workflows.definitions.manage`
- `workflows.definitions.publish`
- `workflows.runs.read`
- `workflows.runs.execute`
- `workflows.runs.cancel`

Definition permissions do not imply action permissions. Publishing verifies
that the publisher can inspect every referenced agent and action. Live
execution checks the workflow permission and intersects each node with the
trusted permission snapshot captured at enqueue.

A workflow cannot grant a scope, tool, agent, or action. A node cannot accept a
tenant or permission list from graph data.

The workflow audit chain records:

- definition create, draft save, publish, archive, and eligible
  delete;
- run enqueue, claim, recover, settle, refuse, and cancel;
- node start, retry, child correlation, action correlation, settle, and skip;
- payload retention;
- actor, separate origin, subject, safe metadata, previous hash, and event hash.

The following transitions are `audit-required` and commit in one database
transaction with their projection update, ordered run event where a run exists,
and hash-chain event:

- definition create, draft save, publish, archive, and eligible delete;
- run enqueue, live or simulation refusal, claim after enqueue, recovery,
  cancellation request, and terminal settlement;
- node attempt start, retry schedule, child or action correlation, terminal
  attempt settlement, and node skip;
- payload retention before deletion.

Lease renewal, heartbeat, safe payload read, and edge-only settlement do not
enter the tenant hash chain. Edge settlements remain immutable ordered run
events and are correlated through run and source attempt. This boundary avoids
claiming that high-volume data movement is an administrative action while still
making it reconstructable.

If the audit append or hash update fails, the projection and ordered run event
in that transaction roll back. Cross-module child audit and target-module record
history cannot share a database transaction; the workflow atomically commits
their stable correlation identifiers and each owner keeps its own audit
boundary.

Audit pagination uses tenant sequence descending and the `wfac1` cursor. Verify
returns a typed result with `valid`, `checkedThroughSequence`, and, when broken,
`firstBrokenSequence`, `expectedPreviousHash`, and `actualPreviousHash`. It never
returns secret metadata.

Child agent details remain in agents audit and run history. Business mutation
details remain in the target module history. Workflow events store correlation
ids rather than copying their private evidence.

## Cost accounting

The workflow aggregates child agent usage and cost by child run id. It counts
each terminal child once, including retried nodes that created distinct child
runs. It separates priced cost from unpriced usage.

An action has no inferred price. A versioned action may return an explicit
metering record in a future contract, but version one stores only action
duration and outcome. Workflow cost is therefore child agent cost plus an
`unpricedActions` count, not a guessed total.

```ts
export interface WorkflowUsageRollupV1 {
	readonly version: 1;
	readonly state: 'not-applicable' | 'provisional' | 'final';
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly includedChildRunIds: readonly string[];
	readonly pricedChildRuns: number;
	readonly unpricedChildRuns: number;
	readonly actionInvocations: number;
	readonly unpricedActions: number;
}

export interface WorkflowCostRollupV1 {
	readonly version: 1;
	readonly state: 'not-applicable' | 'provisional' | 'final';
	readonly currency: 'USD';
	readonly amountMicros: number;
	readonly pricingSnapshotIds: readonly string[];
	readonly unpricedChildRuns: number;
	readonly unpricedActions: number;
}
```

All counters and micro-USD amounts are non-negative safe integers. One USD is
1,000,000 micros. A child enters the aggregate once by child run id after its
own terminal usage record is available. The workflow stores that child's
pricing snapshot identifier and never reprices historical usage. A live rollup
is `provisional` while any included child is unsettled and `final` at workflow
terminal settlement. Simulation uses `not-applicable`, zero counters and amount,
and no pricing snapshot. Dry-run creates no rollup. Actions are counted only as
`unpricedActions` in version one.

## API endpoints

Every protected endpoint uses the normal auth identity, trusted tenant, CSRF,
body bounds, and workflow permission.

| Method | Path                            | Permission                      | Purpose                                                                 |
| ------ | ------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/workflows`                | `workflows.definitions.read`    | List definitions and current draft or published revision.               |
| POST   | `/api/workflows`                | `workflows.definitions.manage`  | Create a draft.                                                         |
| GET    | `/api/workflows/detail`         | `workflows.definitions.read`    | Read one definition and revision history.                               |
| POST   | `/api/workflows/update`         | `workflows.definitions.manage`  | Save a draft with expected revision.                                    |
| POST   | `/api/workflows/validate`       | `workflows.runs.execute`        | Pure dry-run and compile report.                                        |
| POST   | `/api/workflows/publish`        | `workflows.definitions.publish` | Publish an immutable pinned revision.                                   |
| POST   | `/api/workflows/archive`        | `workflows.definitions.manage`  | Prevent new live runs.                                                  |
| POST   | `/api/workflows/delete`         | `workflows.definitions.manage`  | Delete only an unpublished unused draft.                                |
| GET    | `/api/workflow-catalog/agents`  | `workflows.definitions.read`    | List exact agent revisions visible to the editor.                       |
| GET    | `/api/workflow-catalog/actions` | `workflows.definitions.read`    | List scoped versioned read and workspace-write actions.                 |
| POST   | `/api/workflow-runs/simulate`   | `workflows.runs.execute`        | Persist a deterministic fixture simulation.                             |
| POST   | `/api/workflow-runs`            | `workflows.runs.execute`        | Enqueue a live published workflow.                                      |
| GET    | `/api/workflow-runs`            | `workflows.runs.read`           | Filter and cursor-page run history.                                     |
| GET    | `/api/workflow-runs/detail`     | `workflows.runs.read`           | Read run, node attempts, edges, usage, cost, and safe payload evidence. |
| GET    | `/api/workflow-runs/events`     | `workflows.runs.read`           | Resume persisted SSE by run and sequence.                               |
| POST   | `/api/workflow-runs/cancel`     | `workflows.runs.cancel`         | Request cooperative cancellation.                                       |
| GET    | `/api/workflow-audit`           | `workflows.runs.read`           | Page workflow-local audit evidence.                                     |
| GET    | `/api/workflow-audit/verify`    | `workflows.runs.read`           | Verify the tenant hash chain.                                           |

Stable errors include:

- `WORKFLOW_NOT_FOUND`
- `WORKFLOW_NOT_PUBLISHED`
- `WORKFLOW_ARCHIVED`
- `WORKFLOW_REVISION_CONFLICT`
- `WORKFLOW_GRAPH_INVALID`
- `WORKFLOW_AGENT_REVISION_MISSING`
- `WORKFLOW_ACTION_VERSION_MISSING`
- `WORKFLOW_PERMISSION_DENIED`
- `WORKFLOW_INPUT_INVALID`
- `WORKFLOW_LIMIT_EXCEEDED`
- `WORKFLOW_IDEMPOTENCY_CONFLICT`
- `WORKFLOW_RECOVERY_INCONSISTENT`
- `WORKFLOW_RUN_TERMINAL`
- `WORKFLOW_CURSOR_INVALID`
- `WORKFLOW_CURSOR_MISMATCH`
- `WORKFLOW_EVENT_CURSOR_INVALID`
- `WORKFLOW_EVENT_CURSOR_CONFLICT`
- `WORKFLOW_EVENT_CURSOR_AHEAD`
- `WORKFLOW_EVENT_SCHEMA_UNSUPPORTED`
- `WORKFLOW_EVENT_TRANSITION_INVALID`

## Persistence outline

All tenant-owned indexes start with `tenant_id`. Cross-module identifiers are
plain references, never foreign keys.

### `workflow_definitions`

- id, tenant_id, key, name, description;
- lifecycle status;
- current draft revision and published revision;
- optimistic revision, created and updated actor and time.

### `workflow_revisions`

- id, tenant_id, workflow_id, revision;
- graph schema version and canonical graph JSON;
- semantic checksum, compiler version, compiled plan JSON;
- immutable publication actor and time;
- unique tenant, workflow, revision.

Published rows are never updated.

### `workflow_runs`

- id, tenant_id, workflow_id, workflow_revision;
- graph checksum, compiler version, mode, status;
- actor kind, actor id, actor label, actor run id or service configuring user;
- origin kind and origin reference;
- permission digest, input hash, payload reference;
- idempotency key, limits, lease owner and expiry;
- typed usage and cost rollup version, state, integer counters, micro-USD,
  pricing snapshot references, and unpriced child and action counts;
- queued, started, completed, cancellation times;
- failure and refusal code.

Unique tenant and idempotency key provides the enqueue backstop.

### `workflow_node_states`

- tenant_id, run_id, node_id, projected execution status;
- latest attempt number, selected outcome port, next_attempt_at;
- first ready, started, and settled times;
- unique tenant, run, node.

This table is a rebuildable projection. It never replaces immutable attempts or
ordered events.

### `workflow_node_attempts`

- tenant_id, run_id, node_id, attempt;
- node type, immutable technical status, separate outcome port;
- input and output hash and payload references;
- child agent run id or action invocation id;
- semantic attempt group and side-effect idempotency key;
- failure, refusal, retry classification and decision, selected backoff,
  next_attempt_at, usage, and cost;
- started, completed, duration.

Unique tenant, run, node, attempt prevents duplicate attempt rows.

### `workflow_edge_transfers`

- tenant_id, run_id, edge_id, source attempt;
- source node and outcome port, target node and port;
- state, stable settlement reason, schema id, payload hash and reference, byte
  size;
- one settled_at timestamp for emitted, closed, and skipped states.

### `workflow_run_events`

- event_id, schema_version, tenant_id, run_id, sequence, catalog event type;
- safe typed payload, recorded_at, optional simulation virtual_offset_ms;
- unique tenant, run, sequence;
- append-only source for SSE and projection repair.

### `workflow_payloads`

- tenant_id, id, kind `execution` or `evidence`, schema id, hash, original byte
  size;
- encrypted bounded JSON plus encryption key id only for execution kind;
- evidence state, bounded safe preview, redaction reason only for evidence kind;
- retention policy, expiry, created time.

Payloads are separate so retention never rewrites core execution evidence.
History and event APIs can select evidence rows only. A database check prevents
an execution row from carrying a preview and an evidence row from carrying
encrypted source data.

### `workflow_audit_events`

- tenant_id, sequence, actor, origin, action, subject, safe metadata;
- occurred time, previous hash, event hash.

The same verifier backs HTTP and a future CLI command.

## Canvas behavior

The editor uses the shared design system. The canvas is one screen with named
subcomponents for node palette, canvas, inspector, validation panel, test panel,
and execution history.

### Editing

- Dragging changes layout only.
- Connecting ports checks direction, cardinality, and obvious schema
  compatibility immediately.
- A cycle is refused as soon as the edge is proposed.
- Node forms use registered agent revisions, action versions, schemas, bindings,
  retry policy, and failure routing. There is no free-form code field.
- Autosave uses expected revision and shows a visible conflict instead of last
  write wins.
- Publish shows graph errors and the exact pinned dependency summary.
- The editor keeps semantic changes and layout changes distinguishable in the
  revision review.

### Testing

- `Dry-run` shows the compiled order, references, permissions, mappings, and
  issues without adding history.
- `Simulate` opens a fixture drawer for nondeterministic nodes. Each node can
  receive safe input, output, decision, failure, and virtual duration fixtures.
- Simulation produces the same event shapes as live execution, marked
  `simulate`.
- `Run live` is explicit and displays referenced agents, actions, required
  permissions, and side-effect risks before enqueue.

### Execution overlay

The canvas reads persisted events and displays:

- pending nodes with neutral state;
- the current node and traversing edge with a restrained animated highlight;
- pass and success in success state;
- fail branch as a normal decision, not an error;
- refused or failed nodes in error state;
- closed and skipped branches with reduced emphasis;
- retry attempt and backoff on the node;
- safe input and output in the inspector;
- total duration, child agent usage, and cost in the run header.

Animation is a projection of event evidence. It never drives execution.
Reopening a run rebuilds the same visual path from stored events.

### Accessibility and small screens

The graph has an equivalent ordered outline that supports keyboard navigation,
node selection, validation, and run inspection. Version one makes full
drag-and-connect editing a desktop interaction. Small screens can inspect,
filter, dry-run, simulate with existing fixtures, start an approved live run,
and cancel it, but do not pretend that precise graph wiring is usable on a
narrow touch viewport.

## Limits

Initial hard limits are contract defaults and may become bounded module
settings without changing the graph format:

- 100 nodes per graph;
- 200 edges per graph;
- 32 schemas per graph;
- 64 KB canonical graph JSON;
- 64 KB invocation input;
- 64 KB one node input or output envelope;
- 1 MB retained safe payload data per run;
- 5 attempts per node;
- 24 hours total live duration;
- 10,000 run events;
- 1,000 history rows per export page, 100 per interactive page;
- no sub-workflow lineage in version one.

The worker keeps only the current node envelopes and compiled plan in memory.
History and large safe payloads remain paged from storage.

## Failure modes

| Failure                            | Required behavior                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Agent revision removed or inactive | Refuse publish or live preflight. Never use latest.                                               |
| Action missing or version changed  | Refuse before invocation. Never invoke a nearby contract.                                         |
| Action is external or destructive  | Exclude it from the catalog and refuse publication or invocation in version one.                  |
| Permission missing                 | Refuse the node before child or action work.                                                      |
| Invalid mapping or schema          | Dry-run or publish error; runtime invalid data follows explicit fail policy.                      |
| Provider timeout                   | Record child correlation, apply bounded retry policy, preserve idempotency.                       |
| Action timeout                     | Observe the action idempotency record before any retry.                                           |
| Action ignores cancellation        | Record non-acknowledgement, observe or time out the accepted invocation, and discard late output. |
| Worker crash                       | Recover lease and resume from committed node intent.                                              |
| Duplicate enqueue                  | Return the original matching run or idempotency conflict.                                         |
| SSE disconnect                     | Execution continues and stream resumes from the run-bound cursor or matching sequence.            |
| Invalid history or event cursor    | Refuse the page or stream without leaking another tenant, run, or filter set.                     |
| Unknown event schema or transition | Stop projection and recovery with a stable refusal. Never skip or guess.                          |
| Payload too large                  | Refuse before persistence or truncate only a declared preview, never the value used by execution. |
| Audit append failure               | Do not commit the state transition that requires the audit event.                                 |
| Retention failure                  | Keep payload and retry later. Never delete before its retention event commits.                    |
| Module absent                      | Capability lookup returns null and caller degrades explicitly.                                    |

## Guarantees

Consumers may rely on:

- immutable published revisions and exact graph checksums;
- exact pinned agent revision and action contract version;
- action nodes are limited to `read` and `workspace-write` risk in version one;
- DAG-only validation and one successful execution per node;
- deterministic sequential topological scheduling in engine version one;
- durable enqueue before acceptance;
- tenant isolation and immutable authorization evidence;
- stable idempotency behavior;
- ordered append-only run events and resumable streams;
- a versioned event catalog with legal run, node, and immutable attempt
  projections;
- full status, node attempt, edge, actor, mode, revision, usage, cost, failure,
  refusal, cancellation, and audit history while payload retention is separate;
- dry-run has a typed response and no invocation history, writes, or effects;
- simulation has separate recorded and virtual time, not-applicable usage and
  cost, and no provider, action, network, business write, or real sleep;
- opaque tenant and filter-bound history cursors and run-bound SSE cursors;
- no arbitrary executable graph configuration.

## Deliberately unspecified

Version one does not promise:

- parallel execution of ready branches;
- wall-clock timing between persisted events;
- provider output determinism;
- implicit JSON Schema compatibility beyond runtime validation;
- retention of safe payload blobs after their configured expiry;
- availability of an archived agent revision unless agents.core advertises it
  as retained and executable;
- action cost unless the action contract explicitly reports it;
- mobile drag-and-connect editing;
- cyclic graphs, waiting for human approval inside a run, subflows, compensation,
  distributed transactions, or exactly-once external systems.

The engine provides effectively-once invocation through durable idempotency.
The target action remains responsible for its own idempotent business effect.

## Rejected alternatives

### Put workflows inside agents.core

Rejected. Agent definitions and one-agent runs remain useful without a graph
editor or workflow worker. This placement adds idle and cognitive cost to every
agent installation and makes agents own process semantics.

### Put workflows inside automations.core

Rejected. Manual calls, module calls, and agent calls do not require a schedule
or webhook. Automations owns time and ingress, not orchestration graphs.

### Store a list of agent ids only

Rejected. It cannot represent validation, typed data, branch decisions, module
actions, failure routes, or audit evidence. It also encourages latest-revision
execution and ambiguous data passing.

### General cyclic process engine in version one

Rejected. Cycles make boundedness, recovery, cancellation, data retention, and
visual reasoning materially harder. Bounded retry is explicit node policy, not
a graph back edge. A future loop node needs its own limit and spec.

### Arbitrary JavaScript or expression nodes

Rejected. They bypass module contracts, permissions, deterministic validation,
and CSP, and turn graph data into executable code. Typed bindings and allowlisted
gate logic cover the stated need.

### Arbitrary HTTP action nodes

Rejected. They create an SSRF and secret-management surface and bypass target
module authorization and audit. Actions must be registered, versioned module
contracts.

### A second workflow action registry beside agent tools

Rejected for version one. Business modules already register bounded tools with
permissions, input schema, timeout, and output limits. Extending that contract
with version and idempotency costs less than maintaining two operation catalogs.

### Let published workflows use the latest agent revision

Rejected. A workflow could change behavior without a workflow revision, making
simulation, audit, and rollback claims false. Exact revision execution is a
publication prerequisite.

### Treat schedules as anonymous system users

Rejected. It loses the configuring human and produces inconsistent target
module history. A service actor plus separate origin is explicit and auditable.

## Staged delivery

### Stage 0: prerequisites

1. Extend kernel `Actor` with `service` and update record history.
2. Add immutable `agent_definition_revisions`, or an equivalent executable
   snapshot store, owned by `agents.core`, including safe adoption of each
   current definition as its first retained revision.
3. Register the additive `agents.run-execution.v2` capability with exact
   revision enqueue, event observation, terminal result, cancellation, and
   structured JSON Schema output. Keep `agents.run-queue` unchanged.
4. Add structured output support to `@flowdular/harness` and provider capability
   discovery. Refuse an agent-decision node when its pinned model cannot produce
   the required structured output.
5. Add trusted `agentId` and `agentName` fields to `AgentToolContext`, sourced
   from the immutable run snapshot, so workflow calls from tools retain the
   actual agent actor and authorizing run.
6. Add optional contract version, output schema, risk, and idempotency metadata
   to registered agent tools. Existing tools remain valid for agent runs but do
   not enter the workflow action catalog until they opt in.
7. Register the additive `agents.actions.v1` public executor with the same
   input, permission, timeout, output, and audit guards used by agent tools.
8. Approve the `workflows.core` spec. Agents must not set it to approved.

### Stage 1: contract, drafts, validation, and canvas

1. Scaffold `workflows.core` from the approved spec.
2. Implement graph schema, pure compiler, issue locations, checksums, revisions,
   migrations, ACL, and tests.
3. Implement the canvas, inspector, outline, optimistic draft save, catalog,
   publication refusal, and dry-run.
4. Keep live publication disabled unless every Stage 0 capability is available.

### Stage 2: deterministic simulation and history

1. Implement fixture simulation with virtual time and no real effects.
2. Persist simulation runs, node attempts, edge evidence, events, payloads, and
   audit correlation.
3. Implement filters, cursor pagination, run detail, SSE resume, and canvas
   playback.

### Stage 3: live agent DAGs

1. Add worker leases, recovery, exact agent revision nodes, agent-decision,
   gates, validation, merge, output, retry, and cancellation.
2. Aggregate child usage and cost.
3. Prove process-loss recovery before and after agent enqueue.

### Stage 4: versioned action nodes

1. Invoke registered versioned `read` and `workspace-write` actions under the
   actor permission snapshot.
2. Prove process-loss recovery and target mutation idempotency.
3. Add the allowed action risk summary and live confirmation in the canvas.

### Stage 5: optional automation bridge and module adoption

1. Add an optional bridge that depends on workflows and automations.
2. Support schedule and signed webhook origins with service actors.
3. Adopt the execution capability in one business module as the reference call
   site.
4. Add an `agent-tool-design` example for a tool that starts a workflow while
   preserving the agent actor and run correlation.

### Stage 6: hardening

1. Load, retention, cancellation, stream resume, tenant isolation, and audit
   tamper tests.
2. Security review of action permissions, payload redaction, exclusion of
   external and destructive actions, and service actor provenance.
3. Browser verification of canvas validation, simulation playback, live status,
   reload resume, history filters, and small-screen read mode.

Cycles, sub-workflows, human approval nodes, compensation, parallel execution,
and arbitrary connectors require later specs and do not enter Stage 0 through
Stage 6 by implication.
