---
name: agent-tool-design
description: Register an agents.core tool from a module against the real harness and composition contract, with the tool shapes, execution model, tests and refusals.
roles:
  - agentic-engineer
  - backend-engineer
  - module-executor
when: A brief asks for an agent, tool, skill, or automation on top of a module.
---

# Design and register an agent tool

## 1. The contract in code

- Composition: `PlatformServerContext` (`modules/auth/src/server/composition.ts`) has `agentTools: PlatformToolRegistry` (`register(tools)`, `list()`; `packages/kernel/src/tool-registry.ts`, duplicate ids throw) and `settings: ModuleSettingsRuntime`. `PlatformServerComposition` is `{ routes, settings?, start? }`. `platform/octane.config.ts` composes every enabled module, declares each `settings`, then calls each `start`.
- Runtime: `modules/agents/src/platform.ts` passes `tools: () => context.agentTools.list()` into `createAgentRuntime` and starts the worker in `start()`, so tools registered by any module during composition are visible to runs regardless of module order.
- Helpers: `@coreloom/module-agents/server` exports `defineModuleAgentTools(tools)` (`modules/agents/src/server/tools.ts`, rejects duplicate ids), and re-exports `defineApiAgentTool`, `defineCliAgentTool`, `AgentTool`, `AgentToolContext` from `@coreloom/harness` (`packages/harness/src/tool-adapters.ts`).
- Skills in `agents.core` are tenant database records behind `agents.skills.read` and `agents.skills.manage`; they are appended to agent instructions. They are unrelated to `.ai/skills/**`, which are files for coding agents.
- ADR 0002 (`docs/adr/0002-durable-agent-execution.md`) fixes the model: instructions are data, tools are registered by the composition, each tool records an endpoint id or a CLI capability id plus its required permissions, runs are durable with leases.

## 2. Tool shapes

```ts
// src/agent/tools.ts
import {
	defineApiAgentTool,
	defineModuleAgentTools,
	type AgentToolContext,
} from '@coreloom/module-agents/server';
import { INVENTORY_PERMISSIONS } from '../acl/permissions.ts';
import type { InventoryRuntime } from '../server/runtime.ts';

export function inventoryAgentTools(runtime: InventoryRuntime) {
	return defineModuleAgentTools([
		defineApiAgentTool({
			id: 'inventory.locations.list', // ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$
			endpointId: 'inventory.locations.list', // an id from src/api/endpoints.ts `endpoints`
			description: 'List stock locations of the active tenant.',
			requiredPermissions: [INVENTORY_PERMISSIONS.read],
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: { query: { type: 'string', maxLength: 64 } },
			},
			execute: async (input: unknown, context: AgentToolContext) =>
				runtime.service().list(context.tenantId).slice(0, 200),
		}),
	]);
}
```

```ts
// src/platform.ts, inside createServerComposition, before the return
context.agentTools.register(inventoryAgentTools(runtime));
```

`defineCliAgentTool({ id, capability: { id, risk }, description, requiredPermissions, inputSchema?, execute })` wraps a module CLI capability and throws at definition time for `external` or `destructive` risk. Both helpers return a frozen `AgentTool { id, transport, target, description, requiredPermissions, inputSchema?, execute }`.

Dependencies: `package.json` gets `"@coreloom/module-agents": "workspace:*"`; `module.json` and `spec/module.yaml` get `{ "id": "agents.core", "range": "^0.1.0" }`. The sandbox session is a pnpm workspace that installs what `package.json` declares, and the `dependencies` gate runs after every turn.

## 3. Execution model you design against (`packages/harness/src/runtime.ts`, `AgentHarness.execute`)

- A tool is offered to the model only when the agent definition lists it in `allowedTools`, the run's `toolGrants` include it, and every `requiredPermissions` entry is in the run's `permissionSnapshot` (taken at enqueue in `modules/agents/src/services/agent-service.ts`). Otherwise `invokeTool` throws `TOOL_NOT_GRANTED`. `assertToolsRegistered` rejects an agent definition that names a tool nobody registered.
- `execute(input, { runId, tenantId, requestedBy, permissions, signal })`. The harness does not validate `input` against `inputSchema`; the tool must.
- Events: `tool.started`, `tool.completed` (no `tool.denied` or `tool.failed`). The run has `timeoutMs` (250 to 86400000) and `maxSteps` (1 to 32); there is no per-tool timeout and no output cap, so a tool bounds its own output (page size, field allowlist).
- Runs are enqueued by `POST /api/agent-runs` behind `agents.runs.execute`, claimed by `AgentWorker` with a lease, and observed through `GET /api/agent-runs` and the SSE stream. Never make a tool block on user input.

## 4. Deliverables for a module

1. Spec: one acceptance scenario per tool (`INVENTORY-TOOL-LIST`): endpoint wrapped, permission required, validated input, what it refuses (no tenant input, no `manage` action without an explicit scenario, bounded output). `agents.core` in `dependencies`.
2. `src/agent/tools.ts` as above; every tool calls the module service through the runtime, never a repository, database handle, filesystem or shell.
3. The `register` line in `src/platform.ts`.
4. Tests (`tests/agent-tools.test.ts`): `execute` rejects a context whose `permissions` lack the scope (the harness would not call it, but the tool is the last line), uses `context.tenantId` and ignores a tenant in the input, and truncates or pages output.
5. An agent definition in the Agents screen lists the tool id in its allowed tools; the run grant carries it; the requesting principal holds the permission. Without all three the tool stays invisible to the model.

## 4b. Worked examples

Spec scenario for a read tool:

```yaml
acceptanceScenarios:
  - id: INVENTORY-TOOL-LIST
    given: An agent run holds inventory.locations.read in its permission snapshot and the tool inventory.locations.list in its grants.
    when: The agent invokes the tool with an optional query up to 64 characters.
    then: The tool returns at most 200 locations of the run's tenant, ordered by code, and refuses any input that names a tenant.
```

Tool test (`tests/agent-tools.test.ts`), independent of the harness:

```ts
import { describe, expect, it } from 'vitest';
import { inventoryAgentTools } from '../src/agent/tools.ts';
import { createInventoryRuntime } from '../src/server/runtime.ts';

const [listLocations] = inventoryAgentTools(
	createInventoryRuntime({ databasePath: ':memory:' }),
);
const context = (permissions: string[]) => ({
	runId: 'run-1',
	tenantId: 'tenant-a',
	requestedBy: 'account-1',
	permissions: new Set(permissions),
	signal: new AbortController().signal,
});

it('uses the run tenant and ignores a tenant in the input', async () => {
	const result = await listLocations!.execute(
		{ tenantId: 'tenant-b' },
		context(['inventory.locations.read']),
	);
	expect(result).toEqual([]); // tenant-a has no rows; tenant-b was never consulted
});

it('refuses a context without the read scope', async () => {
	await expect(listLocations!.execute({}, context([]))).rejects.toThrow(
		/inventory.locations.read/,
	);
});
```

## 5. Settings a tool may depend on

Declare `settings: defineModuleSettings({ moduleId: 'inventory.core', settings: { maxToolRows: { type: 'number', defaultValue: 200, min: 1, max: 1000, visibility: 'private', client: false, scope: 'tenant', label: 'Rows per tool call' } } })` from `@coreloom/kernel` in the composition and read it inside `execute` with `context`-independent access to the platform settings: keep a reference to `PlatformServerContext.settings` in the tool factory and call `settings.get<number>(toolContext.tenantId, 'inventory.core', 'maxToolRows')` per call. Declared settings render in Administration, Settings automatically (`modules/auth/src/client/settings/SettingsView.tsrx`, behind `system.settings.read` and `system.settings.manage`).

## Pitfalls

- A tool id equal to an endpoint id is a convention, not a requirement; keep them equal for traceability.
- `requiredPermissions` must be exactly the endpoint's permission; a weaker list lets a run bypass the endpoint's ACL because the tool calls the service directly.
- Register once per composition; a second `register` with the same id throws at boot and the platform does not start.
- Do not import `@coreloom/module-agents/server` or `@coreloom/harness` in `src/index.ts` or the client; the harness pulls the Vercel AI SDK.
- Playground runs use the tenant's readiness-probed provider; the local simulation provider performs no network call and is the only provider in a fresh install.
