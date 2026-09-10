---
name: cli-extension
description: >-
  Add a module-owned CLI command through commands.json and defineCliExtension,
  with the namespace, risk, approval, and dry-run rules the runner enforces.
roles:
  - backend-engineer
  - module-executor
  - reviewer
when: A module needs an operator command (status, export, grant, verify) reachable as pnpm flowdular <namespace> <action>.
---

# Add a module CLI command

Examples to copy: `modules/agents/src/cli/{commands.json,index.ts}` (read plus a `localOnly` verifier) and `modules/auth/src/cli/{commands.json,index.ts}` (`process` with dry run, `destructive` with confirmation). Small template: `.ai/examples/customer-cli-extension`.

## 1. Declare the capability

`module.json`: add `"cli"` to `capabilities` and

```json
"cli": { "catalog": "src/cli/commands.json", "entry": "src/cli/index.ts" }
```

`packages/contracts/schemas/module.schema.json` requires the `cli` block when the capability is present and the capability when the block is present. The spec `capabilities` list gets `cli` too.

## 2. Catalog: `src/cli/commands.json`

```json
{
	"protocolVersion": 1,
	"moduleId": "inventory.core",
	"commands": [
		{
			"path": ["inventory", "export"],
			"capability": {
				"id": "inventory.export",
				"version": 1,
				"summary": "Export tenant-scoped stock locations to a workspace path.",
				"risk": "workspace-write",
				"requiresApprovedSpec": true,
				"supportsDryRun": true
			}
		}
	]
}
```

Rules enforced by `packages/cli/src/extensions.ts` (`validateCliCatalog`, `loadCliExtensions`):

- `moduleId` equals `module.json` `id`; the module must be enabled in `flowdular.json`, otherwise its commands do not load.
- `path` has at least two segments matching `^[a-z][a-z0-9-]*$`; the first segment equals the first segment of the module id (`inventory` for `inventory.core`) and is not a reserved group (`help`, `doctor`, `capability`, `spec`, `blueprint`, `module`, `setup`).
- `capability.id` starts with `<namespace>.`, is unique across all enabled modules, `version` is an integer >= 1, `summary` 1 to 240 characters.
- `risk` is one of `read`, `workspace-write`, `process`, `external`, `destructive`. A `destructive` capability with `localOnly: true` must also set `confirmation` (`^[a-z][a-z0-9-]{2,63}$`) and `supportsDryRun: true` (schema `allOf` in `cli-extension.schema.json`).

## 3. Implementation: `src/cli/index.ts`

```ts
import { defineCliExtension } from '@flowdular/cli-protocol';

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'inventory.core',
	commands: [
		{
			path: ['inventory', 'export'],
			capability: {
				id: 'inventory.export',
				version: 1,
				summary: 'Export tenant-scoped stock locations to a workspace path.',
				risk: 'workspace-write' as const,
				requiresApprovedSpec: true,
				supportsDryRun: true,
			},
			execute: async (context) => ({
				data: {
					applied: context.apply,
					target: context.arguments[0] ?? 'json',
				},
				evidence: ['modules/inventory/spec/module.yaml'],
				warnings: context.apply ? [] : ['Dry run only.'],
			}),
		},
	],
});

export default cliExtension;
```

`execute(context: { workspaceRoot, moduleRoot, apply, flags: ReadonlyMap<string, string | boolean>, arguments: readonly string[] })` returns `{ data, evidence?, warnings? }` (`packages/cli-protocol/src/index.ts`). The loader (`loadCliCommand`) imports the entry only when the command runs, accepts a `default` or `cliExtension` export, and refuses when `path` or the whole `capability` object differs from the catalog (`commandKey` compares the JSON). Keep both files metadata-identical, down to the summary text. Declare `@flowdular/cli-protocol` in `package.json`. Read module data through the module's own runtime (`xRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot)` then the service), as `modules/agents/src/cli/index.ts` does; never through another module's database.

## 4. What the runner does with the descriptor (`packages/cli/src/runner.ts`, `runExtensionCommand`)

- `risk: 'external'`: refused with `APPROVAL_VERIFIER_REQUIRED`. `risk: 'destructive'` without `localOnly`: the same.
- `localOnly: true`: refused with `LOCAL_ONLY_CAPABILITY` unless `FD_ENV` or `NODE_ENV` is `development` or `test` (unset counts as development).
- `requiresApprovedSpec: true`: needs `--spec <path>` to a schema-valid spec with `status: approved`, otherwise `APPROVED_SPEC_REQUIRED`, `SPEC_VALIDATION_FAILED` or `SPEC_NOT_APPROVED`.
- `destructive` with `--apply`: needs `--confirm <confirmation>` (`CONFIRMATION_REQUIRED`).
- Non-read without `supportsDryRun` and without `--apply`: `EXPLICIT_APPLY_REQUIRED`. Non-read with dry run support and no `--apply` runs with `apply: false` and appends the warning `Dry run only. No writes were authorized.`
- Invocation: `pnpm flowdular inventory export --apply` or `pnpm flowdular capability run inventory.export --apply`; `arguments` are the positionals after the path (or after `capability run <id>`); flags are `--name value`, `--name=value`, or `--flag` (`packages/cli/src/arguments.ts`). `pnpm flowdular capability list` and `describe <id>` show the descriptor; `pnpm flowdular help` lists module paths.

## 5. Tests

`packages/cli/tests/extensions.test.ts` shows the style: call `validateCliCatalog(catalog, manifest)` with a good catalog and with a path that claims a reserved group, assert the error text. In the module, test `execute` directly with a hand-built context (`apply: false` returns the dry-run shape, `apply: true` writes inside `context.workspaceRoot` only). Then `pnpm flowdular module validate --json` and `pnpm flowdular help` (the new path appears once the module is enabled).

## 6. Landing

Sandbox sessions strip `cli` from other modules' manifests and do not run module commands; the CLI parts of a module are exercised after eject or at the repository root. Both paths end with `pnpm verify` and a PR; `.ai/policies/capabilities.yaml` lists module capabilities, add yours.

## Pitfalls

- A `summary` edited in one file only: `CLI implementation for "inventory export" does not match its catalog.`
- Two enabled modules claiming the same `path` or capability id: `CLI command collision`.
- `risk: 'read'` commands run without `--apply`; anything that writes must not be `read`.
- Commands run in the developer's process with the full environment; never print secrets in `data`.
