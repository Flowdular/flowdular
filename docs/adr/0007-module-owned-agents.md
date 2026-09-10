# ADR 0007: Module-owned business agents

- Status: accepted
- Date: 2026-09-02
- Approval gate: `modules/agents/spec/module.yaml` 0.7.0

## Problem

Modules can register tools, but they cannot ship the business-agent behavior
that uses those tools. An operator must recreate the same instructions and tool
allowlist as tenant data. That copy drifts when the module changes and prevents
an enabled module from being agentic by itself.

Every agent managed by `agents.core` is a business agent. "Module-owned" and
"tenant-created" describe who owns its definition, not two different kinds of
runtime. Sandbox coding specialists are a separate development system and are
not registered through this contract.

The concrete consumers are:

1. A business module such as `catalog.core`, which ships a catalog curation
   agent next to its tools.
2. `agents.core`, which lists, configures and executes module-owned agents next
   to tenant-created agents.
3. `workflows.core`, which publishes a graph against an exact executable agent
   revision and must keep that revision after the module publishes a newer one.
4. Any module that invokes an agent through the public run capability using a
   trusted tenant, actor and permission snapshot.

## Decision

Build module-owned business agents, but keep module-owned behavior separate
from tenant-owned execution configuration.

- A module registers a frozen definition with `defineAgent()` during server
  composition.
- The platform carries a generic agent definition registry in the composition
  context. It is created and sealed by the platform, not by `agents.core`.
- `defineAgent()` and the semantic agent types are exported by
  `@flowdular/module-agents/server`. A module using them declares `agents.core`
  as a module dependency and `@flowdular/module-agents` as a package dependency.
- Module source owns identity, display copy, instructions, maximum tool
  allowlist and execution limits.
- Each tenant owns a binding that selects an available provider and model,
  chooses active or paused state, and may reduce the code tool allowlist.
- Module-owned behavior is read-only in the Agents UI. Tenant binding fields
  remain editable under `agents.definitions.manage`.
- Tenant-created definitions keep their current lifecycle and appear separately
  from module-owned agents.

The 0.7.0 specification is approved. Runtime, migrations, UI, and module
integrations implement this contract together.

## Consumer call sites

### A module defines and registers an agent

```ts
// modules/catalog/src/agent/agents.ts
import { defineAgent } from '@flowdular/module-agents/server';

export const catalogCurator = defineAgent({
	moduleId: 'catalog.core',
	key: 'catalog-curator',
	definitionRevision: 1,
	name: 'Catalog curator',
	description: 'Normalizes and enriches catalog items.',
	instructions:
		'Review the requested catalog records. Use only the tools available to you.',
	allowedTools: ['catalog.item.create', 'catalog.item.list'],
	limits: {
		maxSteps: 8,
		timeoutMs: 120_000,
		temperature: 0.2,
		maxOutputTokens: 4_096,
	},
});
```

```ts
// modules/catalog/src/platform.ts
context.agentDefinitions.register([catalogCurator]);
```

The module does not choose credentials, a provider connection or a model. Those
are tenant deployment choices and never belong in a distributable business
agent definition.

### agents.core consumes the sealed registry

```ts
const runtime = createAgentRuntime({
	moduleAgents: () => context.agentDefinitions.list(),
	tools: () => context.agentTools.list(),
	// existing options
});
```

The registry is read when `start()` runs, after every module has composed and
the platform has sealed both registries.

### A module invokes an agent

```ts
await runQueue.enqueue(
	{
		agentId,
		trigger: 'service',
		input,
		toolGrants: ['catalog.item.list'],
		idempotencyKey,
	},
	{
		tenantId: principal.tenantId,
		actor,
		permissionSnapshot: principal.scopes,
	},
);
```

The tenant and authority are trusted context, never input fields. An omitted
`toolGrants` list means no tools, not every tool.

## Public contract

The semantic surface belongs to `@flowdular/module-agents/server`:

```ts
export interface ModuleAgentDefinitionInput {
	readonly moduleId: string;
	readonly key: string;
	readonly definitionRevision: number;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly allowedTools: readonly string[];
	readonly limits: {
		readonly maxSteps: number;
		readonly timeoutMs: number;
		readonly temperature: number;
		readonly maxOutputTokens: number;
	};
}

export interface ModuleAgentDefinition
	extends Readonly<ModuleAgentDefinitionInput> {
	readonly id: string;
	readonly ownership: {
		readonly kind: 'module';
		readonly moduleId: string;
		readonly definitionRevision: number;
	};
}

export function defineAgent(
	input: ModuleAgentDefinitionInput,
): ModuleAgentDefinition;
```

`id` is derived as `module-agent:<moduleId>:<key>` and is limited to 128
characters. The prefix is reserved and tenant-created agents cannot use it.
Callers never supply or parse this id. They treat it as opaque after
registration.

The generic registry belongs to `@flowdular/kernel` so auth and the composition
contract do not import `agents.core`:

```ts
export interface PlatformAgentRegistry<T = unknown> {
	register(definitions: readonly T[]): void;
	list(): readonly T[];
}

export interface MutablePlatformAgentRegistry<T>
	extends PlatformAgentRegistry<T> {
	seal(): void;
}

export function createPlatformAgentRegistry<
	T extends { readonly id: string },
>(): MutablePlatformAgentRegistry<T>;
```

`PlatformServerContext` gains:

```ts
readonly agentDefinitions: PlatformAgentRegistry;
```

The platform creates the registry before module composition and calls `seal()`
after every module has composed but before any module `start()` hook. Duplicate
ids fail registration. Registration after sealing fails. A sealed `list()` is
sorted by id and returns an immutable snapshot.

## Ownership and served state

The API exposes ownership as a discriminated union:

```ts
export type AgentOwnership =
	| { readonly kind: 'tenant' }
	| {
			readonly kind: 'module';
			readonly moduleId: string;
			readonly definitionRevision: number;
	  };
```

A tenant-created agent keeps its positive `revision`. A module-owned agent also
has a tenant-local positive executable `revision` after binding. Before binding,
it is served with `status: 'unconfigured'` and no executable revision. Workflow
catalogs exclude unconfigured agents.

The Agents screen presents two explicit groups:

- Module agents: module, definition revision, provider binding, model, status,
  enabled tools and unavailable reasons. Behavior fields are read-only.
- Custom agents: the existing tenant-created agent table and full create,
  update, archive and eligible-delete lifecycle.

Calling the current tenant-agent update, archive or delete operation with a
module-owned id returns `MODULE_AGENT_READ_ONLY`. Binding changes use a separate
operation so a careless client cannot replace module behavior while appearing
to edit deployment configuration.

## Tenant binding and executable revisions

The tenant binding contains:

```ts
export interface ModuleAgentBinding {
	readonly tenantId: string;
	readonly agentId: string;
	readonly provider: string;
	readonly model: string;
	readonly enabledTools: readonly string[];
	readonly status: 'active' | 'paused';
	readonly moduleDefinitionRevision: number;
	readonly executableRevision: number;
	readonly revision: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}
```

`revision` is the optimistic concurrency revision of the mutable binding.
`executableRevision` is the monotonic revision referenced by runs and workflows.
Creating a binding, changing provider or model, changing enabled tools, or
receiving a higher module definition revision creates a new immutable executable
snapshot. Pausing alone changes availability and audit state without rewriting
an existing snapshot.

The immutable snapshot extends the existing retained revision with ownership and
module definition revision. It contains the resolved provider, model,
instructions, exact enabled tools and limits. It is the only source for an
exact-revision run.

At runtime start, `agents.core` reconciles registered definitions against
existing bindings in one transaction:

- same definition revision and same content hash is unchanged;
- higher definition revision creates the next executable revision for each
  existing binding;
- same definition revision with a different hash fails boot;
- a lower definition revision fails boot;
- a definition absent from the sealed registry is unavailable for new work;
  retained revisions and historical runs remain untouched.

An old retained revision remains executable after a newer module definition is
registered only while the owning module is still present, the selected provider
is usable, and every required registered tool still exists. Module removal is
not promised to keep new workflow executions alive.

## Tool authority

Agent access is a capability intersection, not an instruction convention.

For a tenant-created agent:

```text
effective tools = definition allowedTools
  intersect invocation toolGrants
  intersect registered tools allowed by actor permissions
```

For a module-owned business agent:

```text
effective tools = code allowedTools
  intersect tenant binding enabledTools
  intersect invocation toolGrants
  intersect registered tools allowed by actor permissions
```

The permission term means every `requiredPermissions` entry declared by the
tool exists in the trusted permission snapshot captured at enqueue. Tool ids are
exact identifiers. `*`, prefix patterns and implicit all-tools defaults are
invalid. A grant outside the agent maximum is refused. A missing permission
removes the tool before provider execution and a later invocation is denied
before the tool body runs.

The model never receives `PlatformCapabilityRegistry`. Platform capabilities
are typed module-to-module services. Model-visible authority is only the
registered tool surface enforced by the harness.

Every run persists the effective tool ids and permission digest used for that
decision. The existing short-lived run grant remains bound to both digests.

## Workflow compatibility

`agents.run-execution.v2` continues to use `{ agentId, revision }`. For a
module-owned agent, `revision` means the tenant executable revision, not the code
definition revision or mutable binding revision.

Workflow publication receives only configured active executable revisions. A
published workflow keeps its exact retained snapshot after a module publishes a
higher code revision or a tenant changes the current provider binding. Newly
published workflows select the new current executable revision.

Changing the ownership discriminator is additive for list consumers. Existing
tenant revisions are adopted as `{ kind: 'tenant' }`. Existing workflow rows do
not change shape.

## Guarantees

- Module agent identity is stable for one module id and key.
- Business-agent definition content is immutable within one definition
  revision.
- Duplicate ids, late registration, revision downgrade and same-revision content
  drift fail platform boot before workers start.
- Module behavior cannot be edited or deleted through tenant APIs.
- Tenant bindings cannot enable a tool outside the code allowlist.
- Every execution is tenant-scoped and uses the initiating Actor and trusted
  permission snapshot.
- Workflow execution uses the exact retained executable revision it published.
- Completed runs, revisions and audit evidence survive module removal.
- No credentials or provider secrets enter a code definition, binding response,
  run event or audit payload.

## Deliberately unspecified

- The database table layout and whether reconciliation uses one or several
  internal transactions.
- The visual grouping control used by the Agents screen.
- Internal hashes and serialization used to detect definition content drift.
- Whether a future release offers bulk binding APIs or module installation
  defaults.
- Ordering before the registry is sealed. Consumers may rely only on the sealed
  id order.
- Automatic migration of a binding when its selected provider or a required
  tool disappears. Version one reports the agent unavailable and requires an
  operator decision.

## Lifecycle and errors

- `defineAgent()` validates and freezes one value. Calling it has no I/O.
- Registration is valid only during module composition.
- Double registration and registration after seal are programmer errors and
  throw synchronously.
- `list()` after seal is read-only and repeatable.
- Binding mutations use optimistic concurrency and audit the user actor.
- Runs already durably queued continue from their snapshot when a binding is
  paused or the module reloads.
- New runs refuse `unconfigured`, `paused`, missing-provider, stale-readiness,
  missing-tool and missing-permission states with stable codes.
- Shutdown disposes workers as it does today. The registry owns no timers,
  connections or callbacks.

## Stability and evolution

This surface is experimental with `agents.core` 0.7.0. Identity and revision
semantics are one-way serialized contracts because workflows and run history
store them. They require compatibility tests before the surface can become
stable.

Additive fields belong in the options object. New binding controls must default
to further restriction, never broader authority. Wildcard grants are excluded
from future compatibility.

## Challenge result

### Strongest case for the feature

The feature removes a real manual copy between a module and tenant data. It lets
a module ship a ready business agent and its tools together while keeping
credentials and tenant authority outside the distributable definition. Catalog
and workflows are current, concrete consumers.

### Alternatives rejected

1. Module migrations insert rows into `agents.core`. This crosses a module
   database boundary, needs tenant enumeration, creates unclear uninstall
   behavior and lets code mutate another module's storage.
2. `module.json` embeds agent definitions. This turns long instructions into
   manifest data, duplicates runtime validation, and still needs a registry and
   tenant provider binding.
3. A module ships a tenant-agent template with a Copy button. This is simpler,
   but the copy immediately loses module ownership, safe upgrades and exact
   revision lineage. It does not solve the stated problem.
4. Code pins provider and model. This avoids a binding table but makes modules
   non-portable and can name a connection that does not exist in another tenant.

### Cost and failure modes

Boot registration is O(d) time and O(d) memory for d current module definitions.
Tenant listing is O(d + a) for d module definitions and a tenant agents. Storage
grows O(b \* r) for bindings b and retained executable revisions r, which is the
same deliberate append-only cost already accepted for exact workflow revisions.

The largest blast radius is a bad reconciliation that advances many tenant
bindings during boot. The mitigation is content-addressed comparison, a
transactional repository operation, same-revision drift refusal, fault-injection
rollback tests and no deletion of retained rows.

The strongest surviving objection is operational setup: a module-owned agent is
not runnable until each tenant binds a provider and model. That friction is
intentional. Silent provider selection would make behavior non-portable and
would change published workflows without a new executable revision.

### Verdict

Build the split definition and binding design. Do not build direct database
seeding or a code-pinned provider shortcut.

The falsifying experiment is a thin implementation with one catalog agent and
two tenants using different provider bindings. It must prove distinct tool
reductions, immutable workflow revisions across a code bump, and boot refusal
for same-revision content drift. If that cannot be done without module database
access or mutable workflow behavior, revise this ADR before expanding adoption.
