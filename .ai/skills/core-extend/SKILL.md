---
name: core-extend
description: Change a platform package (contracts, kernel, server, client, ui, cli, sandbox, coding-agent) without breaking the modules and generated files that depend on it.
roles:
  - module-executor
  - reviewer
when: A change is needed under packages/**, platform/**, or the schemas in packages/contracts, and no module-level change can deliver it.
---

# Extend the platform core

This work runs at the repository root; a sandbox session cannot do it (the session workspace holds one module plus read-only `reference/` copies). When a sandbox role needs a core change, it stops with `HANDOFF: none - <the exact core change>` and this skill picks it up.

## 1. Dependency direction

`packages/contracts` (types and JSON schemas, no runtime) -> `packages/kernel` (registry, ACL, settings) -> `packages/server`, `packages/client`, `packages/ui` -> modules -> `platform` (composition) and `packages/cli`, `packages/sandbox`, `packages/coding-agent`, `packages/harness`, `packages/ai-provider`. A lower layer never imports a higher one. `platform/octane.config.ts` imports `@coreloom/module-auth/server` and the generated `modules.server.ts`; nothing else in `packages/` may import a module. `@coreloom/module-auth/server` is effectively part of the server contract: `PlatformServerContext` and `PlatformServerComposition` live in `modules/auth/src/server/composition.ts`.

## 2. Surfaces every module and every agent sees

Keep these stable or migrate every consumer in the same change. `packages/sandbox/src/server/reference.ts` copies them into every session, so agents code against them:

- `packages/server/src/index.ts`: `defineEndpoint`, `HttpProblem`, `jsonResponse`, `problemResponse`, `readJsonObject`, `requiredString`, `optionalString`, `requiredInteger`, types `EndpointIdentity`, `EndpointExecutionContext`.
- `packages/client/src/contributions.ts`: `ModuleClientContext`, `ModuleClientContribution`, `WORKSPACE_SLOTS`, `NavigationGroup`, `createClientContributionRegistry`. `packages/client/src/state.ts`.
- `packages/contracts/src/index.ts` and `packages/contracts/schemas/*.json`.
- `packages/ui/src/index.ts`, `packages/ui/src/components/*.tsrx`, `packages/ui/src/styles/components.css`.
- `modules/auth/src/{index.ts,acl/scopes.ts,domain/types.ts,server/index.ts,services/auth-service.ts}`.
- `AGENTS.md`, `docs/design-system.md`, and `.ai/skills/**` (copied to `reference/skills/`).

## 3. Checklists by change type

Schema change (`packages/contracts/schemas/*.schema.json`):

1. Edit the schema and the matching type in `packages/contracts/src/index.ts`.
2. Update `packages/cli/src/module-scaffold.ts` so a fresh module satisfies the schema, and its test `packages/cli/tests/module-scaffold.test.ts`.
3. Update every `modules/*/module.json` or `modules/*/spec/module.yaml` the change affects, and the `.ai/blueprints/*/required-files.yaml`, `spec-requirements.yaml` and the business manager prompt when keys change.
4. `pnpm validate` (spec, blueprint, module validation) and `pnpm test`.

Server or auth contract (`packages/server`, `modules/auth/src/server/composition.ts`): change the type, then every `src/platform.ts` and `src/api/endpoints.ts` under `modules/`, then `packages/cli/src/module-sync.ts` if the generated composition shape changes, then `platform/octane.config.ts`. Adding a hook to `PlatformServerComposition` (for example an optional `agentTools`) must stay optional so existing modules compile.

Client or UI primitive: add the component to `packages/ui/src/components/`, export it from `packages/ui/src/index.ts`, add its classes to `packages/ui/src/styles/components.css` with tokens only, document props and classes in `docs/design-system.md`, and delete the module-local promotion candidate it replaces. An icon is one path in `ICON_PATHS` (`packages/ui/src/icons/Icon.tsrx`), 24x24 stroke geometry.

CLI: commands are dispatched in `packages/cli/src/runner.ts`; a new core capability is a descriptor in `packages/cli/src/capabilities.ts` (`id`, `version`, `summary`, `risk`, `requiresApprovedSpec`, `supportsDryRun`); flags are parsed by `packages/cli/src/arguments.ts` (`--name value` or `--name=value`, `--flag`); `reservedGroups` in `packages/cli/src/extensions.ts` protects core groups from module namespaces; `pnpm coreloom help` output lists the commands. Tests in `packages/cli/tests`. Update `.ai/policies/capabilities.yaml` and `README.md`.

Sandbox and coding agent: gate ids live in `packages/sandbox/src/server/gates.ts` (`GateId`, `GATE_DEFINITIONS`) and must match the `gates:` front matter of `.ai/agents/sandbox/*.md`; role defaults in `packages/coding-agent/src/roles/defaults.ts` are regenerated from those files (sync script in `.ai/README.md`), never hand-edited; the instruction contract is `packages/coding-agent/src/roles/contract.ts`. Reference copies for sessions: `packages/sandbox/src/server/reference.ts` `REFERENCE_SOURCES`.

Module and blueprint discovery: `packages/cli/src/validation.ts` `findNamedFiles` walks the workspace for `module.json`, `module.yaml` and `blueprint.json`, skipping `node_modules`, `dist` and tool state directories; check its skip list before adding a new discoverable file type.

## 3b. Worked example: how the optional composition members landed

The agent-tool hook, capability registry and module settings show the shape of a safe contract change (`modules/auth/src/server/composition.ts`, `packages/kernel/src/{capability-registry,tool-registry,module-settings}.ts`, `platform/octane.config.ts`):

```ts
export interface PlatformServerContext {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly auth: AuthRuntime;
	readonly settings: ModuleSettingsRuntime; // live, tenant-scoped reads
	readonly agentTools: PlatformToolRegistry; // register(tools), list()
	readonly agentDefinitions: PlatformAgentRegistry; // register(definitions), list()
	readonly capabilities: PlatformCapabilityRegistry; // register(id, service), get(id), has(id)
}

export interface PlatformServerComposition {
	readonly routes: readonly ServerRoute[];
	readonly settings?: ModuleSettingsDeclaration; // declared by the platform after composing
	readonly prepare?: () => void | Promise<void>; // read-only checks before HMR activation
	readonly start?: () => void; // called after every module composed
	readonly stop?: () => void | Promise<void>; // drains background work before disposal
	readonly dispose?: () => void | Promise<void>; // releases owned resources
}
```

New context members are required (every module receives them; nobody has to read them), new composition members are optional (existing modules compile unchanged). The platform composes modules in dependency order, binds each `agentDefinitions` registrar to that module id, declares every `settings`, seals the definitions, runs every `prepare`, retires the old generation, and then calls every `start`. Retirement completes every `stop` before any `dispose`, so background work cannot outlive a repository it uses. The generic registries live in `@coreloom/kernel` so `modules/auth` does not import the harness or a provider module. `agentTools` carries model-visible tool identities; `agentDefinitions` carries immutable module-owned business agent behavior; `capabilities` carries typed public services between modules, with the provider owning the service type and the consumer declaring the module dependency and handling absence from `get`.

## 4. Generated and composed files

`platform/src/generated/modules.server.ts` and `modules.client.ts` are written by `pnpm coreloom module sync --apply` (also run by `pnpm dev` and `pnpm build`). `coreloom.json` `modules.enabled` and `platform/package.json` dependencies are written by `module enable --apply`. Never edit them by hand; change the generator and regenerate. `packages/ui/src/brand/mark.ts` is generated by `node packages/ui/scripts/gen-mark.mjs`.

## 5. Verification

```bash
pnpm verify        # typecheck, test, validate, format:check
pnpm build         # cli build and smoke, module sync --apply, platform build
```

Run the affected package alone while iterating: `pnpm --filter @coreloom/<pkg> test`. A change to `packages/ui` or `packages/client` also needs `pnpm --filter @coreloom/platform typecheck` and a look at the shell in `pnpm dev`.

## 6. Do not build on dead code

`RegisteredModule.navigation` in `packages/contracts` is declared by modules but never read at run time (the shell reads `ModuleClientContribution.navigation`). `validateTaskPacket` and `packages/harness/schemas/task-packet.schema.json` have no runtime caller. Module translations load through `ModuleClientContribution.translations` and the shared client i18n registry; do not introduce a second loader. Extend the live path or remove the dead one in its own change; do not add a third variant.

## Pitfalls

- A new required key in `module.schema.json` breaks every module manifest and the scaffold at once; ship it optional first.
- Changing an error code string (`UNAUTHENTICATED`, `FORBIDDEN`, `CSRF_REJECTED`) breaks module tests that assert it.
- `packages/ui/src/index.ts` imports fonts and `styles/index.css` at module top; a test that imports `@coreloom/ui` needs a DOM environment.
- Prettier uses tabs and `@tsrx/prettier-plugin`; run `pnpm format` before `format:check`.
