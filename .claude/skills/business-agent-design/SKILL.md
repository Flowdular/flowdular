---
name: business-agent-design
description: >-
  Ship a module-owned business agent with defineAgent, an exact tool ceiling,
  tenant provider binding, retained revisions, and tests. Use for business
  automation delivered by a module, not for sandbox coding specialists.
---
# Design a module-owned business agent

`defineAgent()` describes a business agent shipped by a module. It is the same
kind of business agent that appears in `agents.core`, but its behavior is owned
by module source. It is not a sandbox specialist, coding role, `.ai` skill, or
permission grant. Read `docs/adr/0007-module-owned-agents.md` and the approved
module spec before editing.

If a required tool is missing, pause this phase and hand it off as a separate
`agent-tool-design` task. A business agent can use only registered tools.

## Ownership split

The module owns:

- the stable module id and agent key;
- name, description, instructions, and positive definition revision;
- the maximum exact tool allowlist;
- maximum steps, timeout, temperature, and output-token limits.

The tenant owns a separate binding in `agents.core`:

- provider connection and model;
- active or paused state;
- an enabled-tool subset that can narrow the module allowlist;
- optimistic binding revision and the resulting executable revision.

Never put provider ids, model ids, credentials, tenant ids, or tenant-specific
instructions in module source. The Agents UI presents module behavior as
read-only and lets an authorized tenant manager configure only the binding.

## Define and register

Declare `agents.core` in both `spec/module.yaml` and `module.json` dependencies,
and add `"@flowdular/module-agents": "workspace:*"` to `package.json`. Keep the
import server-only.

```ts
// src/agent/agents.ts
import { defineAgent } from '@flowdular/module-agents/server';

export const catalogCurator = defineAgent({
	moduleId: 'catalog.core',
	key: 'catalog-curator',
	definitionRevision: 1,
	name: 'Catalog curator',
	description: 'Reviews and normalizes catalog records.',
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

export const catalogBusinessAgents = [catalogCurator] as const;
```

```ts
// src/platform.ts, during createServerComposition
context.agentDefinitions.register(catalogBusinessAgents);
```

Registration happens during composition. The platform seals
`agentDefinitions` before any module `start()` hook. A malformed definition,
duplicate id, wildcard tool, registration after sealing, code downgrade, or
same-revision content drift fails boot. Do not catch and hide these errors.

`defineAgent()` derives the opaque id
`module-agent:<moduleId>:<key>`, validates the fields, sorts the exact tool ids,
and freezes the result. Callers do not construct or parse the derived id.

## Authority is an intersection

For a module-owned agent, the tools visible to a run are exactly:

```text
code allowedTools
  intersect tenant binding enabledTools
  intersect invocation toolGrants
  intersect registered tools allowed by the actor's saved ceiling
  intersect registered tools allowed by the actor's live permissions
```

Every id is exact. An omitted grant means no tools. `*`, prefixes, and implicit
all-tools behavior are invalid. Every tool independently declares its
`requiredPermissions`; instructions and skills never grant authority. A scope
revoked after enqueue is rechecked before the tool body runs. The model never
receives `PlatformCapabilityRegistry` or direct service, repository, database,
shell, filesystem, or credential access.

The module allowlist is a permanent ceiling for that definition revision. The
tenant may reduce it, and each caller may reduce it again. A caller cannot
broaden it. Keep the list to the smallest surface needed for the stated job.

Mutating tools also follow the durable idempotency contract in
`agent-tool-design`. Do not add a write tool to a business agent until the tool
has its target-side ledger, transaction, replay test, and
`idempotencyProtection: 'target-ledger'` declaration.

## Revisions and workflows

Increase `definitionRevision` whenever any executable module-owned content
changes: instructions, display copy, allowed tools, or limits. Never reuse a
revision with different content and never decrement it.

Binding a provider or model, changing enabled tools, or reconciling a higher
module definition creates a new immutable tenant executable revision. Runs and
published workflows pin that executable revision, not the code definition or
mutable binding revision. Old retained revisions and audit evidence survive an
upgrade or module removal. A removed module-owned agent becomes unavailable for
new work.

An unconfigured module agent remains visible but cannot run or be published in
a workflow. Do not choose a provider or model automatically to make setup look
complete.

## Spec and files

The approved spec states:

- the business outcome and refusal conditions;
- each exact tool and required permission;
- that tenant binding cannot broaden the module ceiling;
- unavailable, unconfigured, revision, and module-removal behavior where
  relevant.

Typical files are:

- `src/agent/agents.ts` for definitions;
- `src/agent/tools.ts` for module tools;
- `src/platform.ts` for both registry calls;
- `tests/business-agents.test.ts` and `tests/agent-tools.test.ts`;
- `spec/module.yaml`, `module.json`, and `package.json` for dependencies and
  the coordinated version bump.

## Tests

The business module proves:

1. The definition has the expected derived id, ownership, revision, limits,
   and exact sorted tool ceiling, and is frozen.
2. Every allowed tool is registered by the module or a declared dependency.

The shared `agents.core` integration suite proves:

1. A tenant binding can reduce tools but cannot add one outside the code
   ceiling.
2. A run without an invocation grant or required live scope never calls the
   tool body and records a denial.
3. Two tenants can bind different providers, models, and tool subsets without
   seeing each other's binding or runs.
4. A higher definition revision retains the old executable revision; a
   downgrade and same-revision drift refuse startup.
5. Module absence blocks new runs while retained run and workflow evidence
   remains readable.

Use the module's isolated test provider for persistence tests. The end-to-end access intersection
belongs in `modules/agents/tests`, while a business module proves its own
definition and tool behavior locally. Do not edit `agents.core` merely to
duplicate its platform contract tests. Run the module tests, typecheck, spec
and module validation, then `pnpm verify` before delivery.

## Refuse

- Treating a sandbox coding specialist as a business agent definition.
- Letting a tenant edit module-owned instructions or the code tool ceiling.
- Wildcard tools, tenant ids in model input, or authority derived from prompts.
- Code-pinned provider connections, models, credentials, or secrets.
- Registration outside `createServerComposition` or after registry sealing.
- A write tool without target-side durable idempotency.
- Reusing a definition revision after changing executable content.
