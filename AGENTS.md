# Coreloom agent contract

Coreloom is an agentic foundation framework. It ships the foundation platform (accounts, workspaces, permissions, modules, agents runtime, CLI, sandbox) and people build their own platform on top of it: in the sandbox with AI specialists, or with the skills in `.ai/skills` inside their own coding tool. This file is the contract every agent works under, in both places. Spec-first is a working rule here: a module is created only from an approved `spec/module.yaml`.

Read first: the skill for the task (`.ai/skills/<name>/SKILL.md`; a sandbox session finds copies under `reference/skills/`), `modules/catalog` as the reference module, and `docs/design-system.md` for anything visual.

## Rules

1. Read the owning code end to end before changing it. Copy the shape of `modules/catalog`; do not invent architecture, permissions, entities, routes, or dependencies. Stop when required input is missing or contradictory and say exactly what you need.
2. Write only inside the paths your role or blueprint names. In the sandbox these paths are advisory; a reviewer treats a write elsewhere as a defect.
3. Identifiers: module, permission and capability ids match `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. `inventory.core` lives in `modules/inventory` as `@coreloom/module-inventory`; permissions are `<module>.<entity>.read` and `<module>.<entity>.manage`.
4. A module is created only from a spec with `status: approved`; an agent never writes `approved`. Spec `permissions[].id` equal the constants in `src/acl/permissions.ts`: the spec is what `auth sync-scopes` grants.
5. Every endpoint is `defineEndpoint` from `@coreloom/server` with `access: { kind: 'permission', permission }` and `resolveIdentity: endpointIdentityFromContext`. Deny by default; a public endpoint needs a written reason. No raw `new ServerRoute` outside `modules/auth`.
6. The tenant id comes only from `principalFromContext(octane)!.tenantId`, never from the body, query or headers. Every query on a tenant-owned table filters by `tenant_id`; unique constraints and indexes start with `tenant_id`; SQL uses bound parameters.
7. Every mutation calls `sessionMutationDenial(octane, auth)` first and reads its body with `readJsonObject` plus `requiredString`, `optionalString`, `requiredInteger`. Clients send `content-type: application/json`, `x-csrf-token`, and `credentials: 'same-origin'`.
8. Routes mount only through `src/platform.ts` exporting `createServerComposition(context)` with `platform.server: true` in `module.json` and a `./platform` export in `package.json`; the context carries `auth`, `settings` and `agentTools`, and the composition may return `settings` and `start`. Client contributions mount only through `createClientContribution(context)` in `src/client/index.ts` with `platform.client: true`. `pnpm oerp module validate` fails on a missing entry (`PLATFORM_*`).
9. Never edit the composition by hand: `platform/octane.config.ts`, `platform/src/App.tsrx`, `platform/src/generated/**`, `platform/package.json` dependencies and `modules.enabled` in `coreloom.json` are written by `pnpm oerp module enable <id> --apply` and `pnpm oerp module sync --apply`.
10. `pnpm oerp module enable <id> --apply` grants the spec permissions to every tenant owner as its last step; `pnpm oerp auth sync-scopes --module <id> --apply` re-grants later (new permission, another database). Members receive scopes only through `MEMBER_SCOPES` in `modules/auth/src/acl/scopes.ts`, a core change.
11. Declare every imported package in the module `package.json`; the sandbox `dependencies` gate and the eject fail otherwise. Every relative import carries its `.ts` or `.tsrx` extension.
12. Use the CLI for discovery, validation and scaffolding: `doctor`, `spec validate`, `module validate`, `module new`, `module enable`, `auth sync-scopes`. Run destructive, external or production capabilities only with what the runner demands (`--apply`, `--confirm`, `--spec`) and never work around a refusal.
13. Gates are `spec-schema`, `module-schema`, `dependencies`, `typecheck`, `tests`, `format`. The sandbox runs `dependencies` plus the ones your role lists after every turn, per draft module, and feeds a failure back to you; with a shell you may run the module's own gate commands yourself, never installs, network or git. From a checkout run them yourself and `pnpm verify` before any pull request.
14. Build UI only from `@coreloom/ui` components, `ui-*` classes and tokens (`docs/design-system.md`). No hardcoded colors, fonts or sizes; never restyle a `ui-*` class; `glyph` and `Icon name` are `ICON_PATHS` keys. A missing primitive becomes a module-local component on tokens, flagged as a promotion candidate.
15. One screen, form, table or stateful region per named component. Records own the page; create and edit happen in a `Drawer`. Every screen shows loading, empty, error, populated and denied.
16. Tests live in `tests/*.test.ts` and use `':memory:'` repositories: identity, tenant isolation, uniqueness, one 401 and one 403 per endpoint, each validation bound. The sandbox `tests` gate passes with zero tests, so an empty suite is a defect.
17. Translations are inert: `translations/*.json` hold `module.name` per declared locale with identical key sets; UI copy is English literals in `.tsrx`.
18. Schema is the constant in `src/services/migration.ts`, executed by the repository constructor, mirrored into `migrations/000N_<module>_<name>.{up,down}.sql`; additive and idempotent only, `STRICT`, `CHECK`, tenant-first indexes. There is no migration runner.
19. Module CLI commands live in `src/cli/commands.json` and `src/cli/index.ts`, metadata-identical, inside the module namespace.
20. Passwords, session tokens and provider credentials never leave `auth.core` (or the `agents.core` vault) and never appear in logs, audit metadata or responses.
21. `setup quick` and `auth greenfield` are destructive local resets. Preview first, stop the app, never point them at a custom or deployed database.
22. Agent workers reach ERP data only through registered API or CLI tools. A module registers them inside `createServerComposition` with `context.agentTools.register(defineModuleAgentTools([...]))` from `@coreloom/module-agents/server`; nothing else registers a tool.
23. A background run is persisted before enqueue returns; idempotency, leases, recovery, tenant scoping and append-only audit evidence for every fire-and-forget run.
24. Module settings are declared with `defineModuleSettings` from `@coreloom/kernel`, returned as `settings` from the composition, read live with `context.settings.get(tenantId, '<module>.core', key)`, and rendered in Administration, Settings. A cross-module read needs a declared dependency and a `shared`, non-secret setting. Cross-module data goes through the other module's public service, never its database.
25. `Development` navigation is owner-only in the client; server permissions remain authoritative.
26. Generated files are production code: no placeholders, silent fallbacks or skipped tests. `module.json` `version`, spec `specVersion` and `package.json` `version` move together.
27. Commits and pull requests: short body, one line on verification, no AI attribution footers, generated files only through the CLI. Never use em or en dashes in anything you write.
28. End a sandbox turn with one line: `HANDOFF: <role-id> - <why>` or `HANDOFF: none - <why>`. The role must be in your role's `handoff` list and never yourself; otherwise the sandbox routing decides.

## Sequence

Sandbox: brief, planner picks the kind and first role, specialist turns with gates per module, approval of the spec (new module), scaffold, eject (gates, copy and removals, `pnpm install`, `module enable` with scope grant, `auth sync-scopes`, platform typecheck, restart note), pull request.

Checkout: read the skill, approved spec, `module new` dry run then `--apply`, implement, gates, `module enable --apply` (grants scopes), `pnpm verify`, pull request.
