# Modules

A module is a self-contained slice of the product: its own permissions,
endpoints, migrations, services, screens, translations and tests, wired into the
platform without touching a core file. `.ai/references/catalog` is the pinned reference
implementation; copy its shape.

## Lifecycle

```text
approved spec -> module new -> implement -> gates -> module enable -> verify
```

### 1. Specification

A module is created only from a `spec/module.yaml` with `status: approved`. The
spec is the contract: `permissions[].id` equal the constants in
`src/acl/permissions.ts`, and those permissions are exactly what
`auth sync-scopes` grants. An agent never approves a spec on its own judgment.

```bash
pnpm flowdular spec validate --all
```

### 2. Scaffold

```bash
pnpm flowdular module new sales.orders \
  --spec modules/sales-orders/spec/module.yaml            # dry run
pnpm flowdular module new sales.orders \
  --spec modules/sales-orders/spec/module.yaml --apply
```

The scaffold derives everything from the spec: `platform.server` and
`platform.client` flags from the capabilities, `src/platform.ts` and
`src/client/index.ts` with the canonical `createServerComposition` and
`createClientContribution` entries, one `defineEndpoint` per
`<ns>.<entity>.read` (list) and `.manage` (create) permission of the first
entity, and, with the `database` capability, an asynchronous repository on the
`@flowdular/database` provider, a runtime that acquires and releases its lease,
and `migrations/0001_*.up.sql` and `.down.sql` with the tenant table and its
forced row-level security block. The contract is in
[Database adapters](database-adapters.md) and the `database-adapter` skill.

Files are written through the workspace Prettier, so the format gate passes
without a rewrite. A directory that already holds `spec/module.yaml` or
`translations/**` is extended, not rejected, and a failed run leaves nothing
behind.

### 3. Implement

Rules that bite first (the full contract is in [../AGENTS.md](../AGENTS.md)):

- Tenant id comes only from `principalFromContext(octane)!.tenantId`; every
  query on a tenant-owned table filters by `tenant_id`.
- Every endpoint is `defineEndpoint` with an explicit permission; every mutation
  starts with `sessionMutationDenial(octane, auth)`.
- Numbered `migrations/000N_*.up.sql` files are the schema source and are
  immutable once applied; add a new additive migration instead of editing one.
- Repositories acquire their database through `context.databases`, keep service
  and endpoint callers asynchronous, run every operation inside
  `database.transaction(..., { tenantId, access })`, and ship explicit
  PostgreSQL SQL plus migration adoption checks.
- UI is built only from `@flowdular/ui` components, `ui-*` classes and tokens
  ([design-system.md](design-system.md)).
- Cross-module operations go through a typed public service registered in
  `context.capabilities`, never another module's database.
- Every imported package is declared in the module `package.json`; relative
  imports carry `.ts` or `.tsrx`.

### 4. Validate

```bash
pnpm flowdular module validate
pnpm --filter @flowdular/module-<dir> typecheck
pnpm --filter @flowdular/module-<dir> test
```

`module validate` checks more than the schema: `platform.server` requires
`src/platform.ts` and a `./platform` export, `platform.client` requires
`src/client/index.ts` and a `./client` export, and every declared locale needs a
`translations/<locale>.json` with the same key set as the others (an error).
`module.json` version drift against `specVersion`, or a locale missing from
`flowdular.json`, is reported as a warning.

### 5. Enable

```bash
pnpm flowdular module enable sales.orders --apply
pnpm flowdular module disable sales.orders --apply
```

`enable` resolves the module's complete dependency closure, writes every newly
enabled module to `flowdular.json` in deterministic dependency-first order, adds
the required packages to `platform/package.json`, runs `pnpm install` when a
package is not linked yet, and regenerates
`platform/src/generated/modules.{server,client}.ts`. With `--apply` it also
grants the scopes declared by each newly enabled module to every workspace owner
through `auth sync-scopes`; a failed grant is reported as
`MODULE_SCOPES_SYNC_FAILED`, and when `auth.core` is unavailable the grant is
skipped with a warning.

`disable` refuses while another enabled module depends on the target, then
removes it and regenerates. `system.core` and `auth.core` are protected.

A running `pnpm dev` picks the change up live: the octane plugin reloads server
routes when the generated composition changes and the client hot-reloads, so no
rebuild is needed. `pnpm dev` and `pnpm build` run the sync automatically.

## Files the CLI owns

Never edit these by hand:

- `flowdular.json` `modules.enabled`
- `platform/package.json` dependencies
- `platform/src/generated/**`
- `platform/octane.config.ts` and `platform/src/App.tsrx`

## Module settings

Modules can also contribute standalone public or protected web pages outside the
workspace shell. See [Module web surfaces](module-web-surfaces.md) for page
entries, layouts, tenant-bound path mounts, loaders and access rules.

Settings are declared with `defineModuleSettings` from `@flowdular/kernel`,
returned as `settings` from the composition, read live with
`context.settings.get(tenantId, '<module>.core', key)`, and rendered in that
module's drawer under Administration, Modules. Administration, Settings holds
only workspace and organization settings.

## Adding a CLI command

Module commands live in `src/cli/commands.json` and `src/cli/index.ts`,
metadata-identical, inside the module namespace. See
[cli-extensions.md](cli-extensions.md).

## Guided procedures

Each change class has a canonical skill in [`.ai/skills`](../.ai/skills).
RuleSync generates the discovery copies for supported coding agents:
`module-new`, `module-update`, `migration-authoring`, `ux-design`,
`database-adapter`, `translations-i18n`, `auth-security-review`,
`test-hardening`, `cli-extension`, `agent-tool-design`,
`business-agent-design`, `workflow-development`, `release-eject-pr`.

Official business modules are maintained outside core. See [module distribution](module-distribution.md) for install, update, lock verification and release checks.
