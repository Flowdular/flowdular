# Developing a generated application

Use this map when working in an application created by `create-flowdular`.
Choose one task skill from `.ai/skills/README.md` for the current phase. Read the
owning code and the relevant section below; do not preload every skill.

## Establish the actual project layout

1. Read root `package.json`, `flowdular.json` and the target module's
   `package.json`, `module.json` and `spec/module.yaml`.
2. Identify existing behavior, requested changes, permissions and affected
   locales. A new module needs an explicitly approved specification before
   implementation. Ask for missing business decisions before inventing fields,
   roles, calculations or workflow transitions.
3. Work in `modules/<directory>`. The starter is `modules/example`, with package
   name `@app/module-example`; other modules may use another naming convention.
   Never derive a pnpm package selector from an SDK import or module id.
4. `platform/src/App.tsrx`, `platform/src/generated/**`, generated composition and
   enabled-module dependencies are CLI-owned. Use `pnpm flowdular module sync
--apply` to regenerate composition after a declared contract change.
5. Core modules and platform packages are installed under
   `platform/node_modules/@flowdular/sdk`. Upstream paths in shared skills such
   as `modules/auth` and `packages/server` refer to that read-only tree. Public
   exports are listed in its `package.json`. Import them through
   `@flowdular/sdk/server`, `@flowdular/sdk/client`, `@flowdular/sdk/ui`,
   `@flowdular/sdk/database` and the relevant exported subpath. Never patch
   installed source to deliver a feature. CLI and sandbox internals require an
   upstream Flowdular change, not a new application-local copy.

## Choose the smallest complete change

Paths below are relative to the module directory. Keep the approved spec and
manifest aligned. An implementation must include observable regression evidence.

| Requested change                   | Task skill              | Owning files and completion evidence                                                                                                                            |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New module                         | `module-new`            | Approved `spec/module.yaml`; run scaffold preview then apply; implement the remaining business behavior; validate, enable and grant explicitly                  |
| New entity field or endpoint       | `module-update`         | `src/domain`, `src/services`, `src/api/endpoints.ts`, client consumers and spec; reject invalid inputs and preserve existing behavior                           |
| New permission or protected action | `auth-security-review`  | `src/acl/permissions.ts`, endpoint identity/permission, spec and UI availability; prove unauthenticated, denied and cross-tenant cases                          |
| Database table or column           | `migration-authoring`   | New immutable `migrations/*.sql`, matching `databaseMigrations`, repository mapping and spec; test fresh migration and tenant isolation                         |
| Persistence query                  | `database-adapter`      | `src/services/database-repository.ts` and repository port; bound SQL and transactions using the authenticated tenant; exercise the real test provider           |
| Screen, table or edit form         | `ux-design`             | `src/client/*View.tsrx`, `state.ts`, `api.ts`, `contribution.tsrx`; use shared UI, inspect loading/empty/error/populated/denied states and keyboard interaction |
| Navigation or translated copy      | `translations-i18n`     | `src/client/contribution.tsrx`, all configured `translations/*.json` and consumers; validate matching keys and plural forms                                     |
| Workflow or automation             | `workflow-development`  | Module-owned workflow definition and invocation through public capabilities; test publication, execution, failures and permission boundaries                    |
| Agent tool                         | `agent-tool-design`     | Tool registration, input/output contract, permission ceiling, idempotency and audit; test actual harness invocation and denial                                  |
| Business agent                     | `business-agent-design` | Agent declaration, public tools and tenant-bound provider; test allowed and forbidden behavior, revisions and cleanup                                           |
| Module CLI command                 | `cli-extension`         | `src/cli/commands.json`, handler, module export and manifest; test dry run, authorization and applied effects                                                   |
| Defect or failed check             | `bug-hunt`              | First reproduce at the owning layer, then fix and rerun the failing test; inspect sibling paths                                                                 |
| Final delivery                     | `auto-review`           | Review the whole diff against requirements and executable evidence; report unresolved findings and actual check results                                         |

For a multi-part feature, finish each bounded implementation phase, then select
the next skill. In sandbox sessions, follow the assigned role's write paths and
handoff list. A backend role must hand a client fix to the frontend role; a failed
gate does not expand its authority. Direct coding agents still keep module
boundaries and preserve other contributors' changes.

## Verification in this application

For the example module, run:

```sh
pnpm --filter @app/module-example typecheck
pnpm --filter @app/module-example test
pnpm flowdular module validate
pnpm verify
pnpm build
```

For another module substitute its actual package name. A green command with no
tests is not evidence. Test public behavior, input bounds, permission denial and
tenant isolation. Database tests use isolated embedded PostgreSQL or the
configured test provider, never the application's local demo or hosted database.
Do not claim a hosted PostgreSQL check ran when only embedded tests ran.

`pnpm build` uses isolated temporary state and ephemeral build keys. `pnpm
flowdular setup` configures the application. Local demo reset requires stopping
the application and must never target a deployed database.

Inspect rendered UI after changing a screen. Run the `auto-review` skill as a
separate phase after implementation. Report changed behavior, checks actually
run, remaining failures and any required operator action. Commit/push or open a
PR only within the user's authorization; agent changes do not grant themselves
spec approval or production access.

## Maintain the agent guidance

Edit `.ai/rules` and `.ai/skills`, then run `pnpm rules:generate` and
`pnpm rules:check`. Codex reads `AGENTS.md` and `.agents/skills`; Claude Code reads
`CLAUDE.md` and `.claude/skills`. Keep generated copies synchronized. `.ai/agents`
contains reusable role instructions; `.ai/blueprints` and `.ai/policies` are
project-local inputs referenced by `flowdular.json`.

Split a skill when it contains independent procedures with different owning
files, write scopes or verification commands. Keep shared requirements in the
rules and concrete recipes in the task skill. Each recipe should state its
trigger, inputs, touch list, ordered steps, failure cases and completion checks.
Do not add a skill that only renames an existing procedure.
