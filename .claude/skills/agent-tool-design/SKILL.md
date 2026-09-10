---
name: agent-tool-design
description: >-
  Register an API or CLI tool that lets business agents act on a module, with
  the real harness, permission, idempotency, audit, and test contract.
---
# Design and register an agent tool

A module lets agents act on it by registering tools during composition. A tool
wraps one service operation, takes the tenant from the run context, reuses the
service validation, bounds its output, and declares the exact permission the
matching endpoint requires. `parties.core` and `catalog.core` are the reference
implementations.

This skill designs tools, not business-agent behavior. When a module should
also ship a ready business agent through `defineAgent()`, read
`business-agent-design` and register only the exact tools that agent needs.

## 1. The contract in code

- Composition: `PlatformServerContext` (`modules/auth/src/server/composition.ts`) carries `agentTools: PlatformToolRegistry` (`register(tools)`, `list()`; `packages/kernel/src/tool-registry.ts`; a duplicate tool id throws at boot), `settings: ModuleSettingsRuntime`, and `capabilities: PlatformCapabilityRegistry` (`register(id, service)`, `get(id)`, `has(id)`; `packages/kernel/src/capability-registry.ts`). `platform/octane.config.ts` creates the registries, passes them to every module's `createServerComposition`, declares each `settings`, owns each `dispose`, then calls each `start`.
- Ordering is a non-issue: `agents.core` (`modules/agents/src/platform.ts`) passes `tools: () => context.agentTools.list()` into `createAgentRuntime`, and the harness is built lazily in `start()`, which runs after every module has composed. Tools any module registers during its own compose are therefore visible, whatever the module order.
- Helpers: import `defineApiAgentTool` from `@flowdular/harness/tool-adapters` and the types `AgentTool`, `AgentToolContext` from `@flowdular/harness/runtime`. Both subpaths are free of the Vercel AI SDK; only the harness root (`@flowdular/harness`) and `@flowdular/module-agents/server` pull it. `defineApiAgentTool` returns a frozen `AgentTool { id, transport: 'api', target, description, requiredPermissions, inputSchema?, execute }`. `defineCliAgentTool({ id, capability: { id, risk }, ... })` wraps a CLI capability and throws at definition time for `external` or `destructive` risk.
- Skills inside `agents.core` are tenant database records behind `agents.skills.*`, appended to agent instructions. They are unrelated to `.ai/skills/**`, which are files for coding agents.
- A read tool's output can also become a resolvable `{{ variable }}` for variable-aware fields: the tool's `requiredPermissions` is the variable's scope mask. Register a source on `platformVariableRegistry(context.capabilities)`, require an explicit record binding, and invoke the tool with the trusted tenant, actor permission snapshot, and signal. See the `variables` skill for the complete refusal contract.
- ADR 0002 (`docs/adr/0002-durable-agent-execution.md`): instructions are data, tools are registered by the composition, each tool records an endpoint id or a CLI capability id plus its required permissions, runs are durable with leases.

## 2. Tool shape

```ts
// src/agent/tools.ts
import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import type { AgentTool } from '@flowdular/harness/runtime';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type { PartyKind } from '../domain/types.ts';
import type { PartiesRuntime } from '../server/runtime.ts';

const MAX_TOOL_ROWS = 200;

export function partiesAgentTools(
	runtime: PartiesRuntime,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: 'parties.customer.list', // ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$
			endpointId: 'parties.records.list', // the read endpoint this wraps
			description: 'List customers and suppliers of the active tenant.',
			requiredPermissions: [PARTY_PERMISSIONS.read],
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					status: { type: 'string', enum: ['active', 'archived'] },
					query: { type: 'string', maxLength: 120 },
				},
			},
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				const query =
					typeof value.query === 'string'
						? value.query.trim().toLocaleLowerCase('en-US')
						: '';
				return runtime
					.service()
					.list(context.tenantId) // tenant from the run, never from input
					.filter(
						(party) =>
							query === '' ||
							party.name.toLocaleLowerCase('en-US').includes(query),
					)
					.slice(0, MAX_TOOL_ROWS); // bound output
			},
		}),
		defineApiAgentTool({
			id: 'parties.customer.create',
			endpointId: 'parties.records.create',
			description: 'Create a customer or supplier owned by the active tenant.',
			requiredPermissions: [PARTY_PERMISSIONS.manage],
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'kind'],
				properties: {
					name: { type: 'string', maxLength: 160 },
					kind: { type: 'string', enum: ['customer', 'supplier', 'both'] },
					vatId: { type: 'string', maxLength: 20 },
				},
			},
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				// The service revalidates every field, so a tool cannot persist
				// what the endpoint would reject.
				return runtime.service().create(context.tenantId, {
					name: String(value.name ?? ''),
					kind: value.kind as PartyKind,
					vatId: typeof value.vatId === 'string' ? value.vatId : null,
				});
			},
		}),
	];
}
```

```ts
// src/platform.ts, inside createServerComposition, before the return.
// register takes readonly unknown[], so no cast is needed.
context.agentTools.register(partiesAgentTools(runtime));
```

Export the factory from `src/server/index.ts` so tests and the composition reach it.

Dependencies: `package.json` gets `"@flowdular/harness": "workspace:*"`. You do not import `@flowdular/module-agents` and you do not add `agents.core` to `module.json`: registration flows through the platform-provided registry on the composition context, not an import of agents.core. Adding a scenario bumps `spec/module.yaml` `specVersion` and `module.json` `version` together.

## 3. Execution model you design against (`packages/harness/src/runtime.ts`, `AgentHarness.execute`)

- A tool is offered only when the agent definition lists it in `allowedTools`, the run's explicit `toolGrants` include it, every `requiredPermissions` entry is in the enqueue-time permission ceiling, and the initiating user still holds every permission when the tool is called. The auth runtime reauthorizes the trusted actor and tenant before every call. A stored snapshot never becomes future authority, newly granted scopes do not elevate an old run, and a service actor stays tool-less until its owning module supplies an explicit revocable policy. Otherwise the harness emits `tool.denied` and throws a stable refusal. `assertToolsRegistered` rejects a new run whose agent names an unregistered tool, while an exact idempotent retry returns its already persisted run before consulting mutable definitions or registries.
- `invokeTool` validates `input` against `inputSchema` first, using a small JSON Schema subset (`type`, `enum`, `required`, `properties`, `additionalProperties: false`, `items`; `packages/harness/src/tool-contract.ts` `validateToolInput`). A violation emits `tool.denied` (reason `TOOL_INPUT_INVALID`) before `execute` runs. The subset does not check string length or format, so the tool enforces those by passing input through the module service.
- `execute(input, { runId, tenantId, requestedBy, actor, idempotencyKey, permissions, signal })`. Take the tenant from `context.tenantId`. `permissions` is the intersection of the original ceiling and live authorization. `actor` describes the agent run for record history. `additionalProperties: false` already makes the harness refuse a stray `tenantId` field, but never read one anyway.
- A mutating tool with `idempotency: 'required'` is executable only after the target module implements a durable ledger and the definition declares `idempotencyProtection: 'target-ledger'`. The harness derives a stable key from the durable run id and deterministic tool-call ordinal. The target ledger binds `(tenant, tool id, key)` to a canonical input hash and the first result. A replay returns that result without another mutation; the same key with another tool or input fails closed. Provider tool-call ids are audit metadata only. Never add the declaration before the target migration, repository transaction, and crash-recovery test exist.
- Each call has a deadline (`tool.timeoutMs`, default 30 s, range 250 to 600000) and the harness caps serialized output at 32 KB (`boundToolOutput`), marking `truncated`. Still page or limit your rows so one call cannot dominate the run window.
- Events per call land in the run's persisted audit chain: `tool.started`, then `tool.completed` (metadata `tool`, `outputCharacters`, `truncated`) on success, `tool.failed` (reason) on error, or `tool.denied` (reason) when not granted or input-invalid.
- Runs are enqueued by `POST /api/agent-runs` behind `agents.runs.execute`, claimed by `AgentWorker` with a lease, observed through `GET /api/agent-runs` and the SSE stream. The registered tool ids surface in `GET /api/agents` `tools`, which the Agents form reads to build the allowed-tools grid. Never make a tool block on user input.

## 4. Deliverables for a module

1. Spec: one acceptance scenario per tool group (`PARTIES-AGENT-TOOL`): endpoint wrapped, permission required, validated input, what it refuses (no tenant input; a `manage` tool needs an explicit scenario; bounded output). Bump `specVersion` and `module.json` `version` together.
2. `src/agent/tools.ts`: every tool calls the module service through the runtime (never a repository, database handle, filesystem or shell), takes `context.tenantId`, and reuses the service validation.
3. The `register` line in `src/platform.ts`, and the factory exported from `src/server/index.ts`.
4. For a mutating tool, a numbered migration and target-side idempotency ledger, with the migration mirrored byte for byte in `src/services/migration.ts`. The service commits the business mutation and ledger result in one transaction.
5. Tests, below, including a replay of the complete harness execution with the same run id and no second business row.
6. In the Agents screen an agent definition lists the tool id in its allowed tools, the request carries it in `toolGrants`, and the initiating principal still holds the permission. Without all three the tool stays invisible to the model.

## 4b. Worked example

Spec scenario:

```yaml
acceptanceScenarios:
  - id: PARTIES-AGENT-TOOL
    given: An agent run holds parties.records.manage in its permission snapshot and the tool parties.customer.create in its grants.
    when: The agent invokes the tool with a valid party, and a run without the manage scope invokes the same tool.
    then: The scoped run creates a tenant-owned party from the run tenant and the harness denies the unscoped run before any write.
```

Module-local test (`tests/agent-tools.test.ts`) drives `execute` directly. It does
not assert on `context.permissions`: RBAC is the harness's job, not the tool's.

```ts
import type { AgentToolContext } from '@flowdular/harness/runtime';
import { describe, expect, it } from 'vitest';
import { partiesAgentTools } from '../src/agent/tools.ts';
import { createPartiesRuntime } from '../src/server/runtime.ts';

const context = (tenantId: string): AgentToolContext => ({
	runId: 'run-1',
	tenantId,
	requestedBy: 'account-1',
	permissions: new Set<string>(),
	signal: new AbortController().signal,
});

it('creates under the run tenant and ignores a tenant in the input', async () => {
	const runtime = createPartiesRuntime({ databasePath: ':memory:' });
	const [, create] = partiesAgentTools(runtime);
	await create!.execute(
		{ name: 'Acme', kind: 'customer', tenantId: 'tenant-b' },
		context('tenant-a'),
	);
	expect(runtime.service().list('tenant-a')).toHaveLength(1);
	expect(runtime.service().list('tenant-b')).toHaveLength(0);
});

it('reuses the service validation so a tool cannot bypass the endpoint', async () => {
	const [, create] = partiesAgentTools(
		createPartiesRuntime({ databasePath: ':memory:' }),
	);
	await expect(
		create!.execute(
			{ name: 'Acme', kind: 'customer', vatId: 'PL-123' },
			context('tenant-a'),
		),
	).rejects.toMatchObject({ code: 'INVALID_VAT_ID' });
});
```

Prove RBAC through the harness (in `modules/agents/tests` with a fake provider,
where the create tool runs against a `:memory:` repository): a run holding the
`manage` scope creates the row and emits `tool.started`/`tool.completed`; a run
whose snapshot lacks it emits `tool.denied` (`TOOL_NOT_GRANTED`) and writes
nothing.

## 5. Settings a tool may depend on

Declare `settings: defineModuleSettings({...})` (from `@flowdular/kernel`) by returning it from the composition, keep a reference to `PlatformServerContext.settings` in the tool factory, and read it per call as `settings.get<number>(context.tenantId, '<module>.core', 'key')` at request time, never at boot. Declared settings render in the module's drawer under Administration, Modules automatically.

## Pitfalls

- A tool id equal to an endpoint id is a convention, not a requirement; keep them parallel for traceability. A read-by-id tool with no dedicated endpoint reuses the read endpoint id under the same permission.
- `requiredPermissions` must be exactly the endpoint's permission; a weaker list lets a run bypass the endpoint's ACL because the tool calls the service directly.
- Register once per composition; a duplicate id throws in the registry at boot and the platform does not start.
- Import the helpers from `@flowdular/harness/tool-adapters` and `@flowdular/harness/runtime`; never import the harness root or `@flowdular/module-agents` from `src/index.ts` or the client, which would pull the Vercel AI SDK into the client bundle.
- The harness validates only the schema subset; deep validation is the service's job. Pass input through the service so a tool cannot persist what the endpoint would reject.
- Playground runs use the tenant's readiness-probed provider; the local simulation provider performs no network call and is the only provider in a fresh install.
