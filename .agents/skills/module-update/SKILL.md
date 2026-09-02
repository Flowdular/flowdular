---
name: module-update
description: Change an existing module (endpoint, table, screen, permission, widget) with the fixed touch list per change class and the version bump rules.
roles:
  - backend-engineer
  - frontend-engineer
  - ux-designer
  - business-manager
  - agentic-engineer
  - module-executor
when: A brief names an existing module, or a sandbox session is labelled edit-module.
---

# Update an existing module

## 1. Read first

Read the whole module before changing it: `spec/module.yaml`, `src/index.ts`, `src/acl/permissions.ts`, `src/api/endpoints.ts`, `src/services/*`, `src/client/*`, `tests/`. Keep every exported name in `src/index.ts`, `src/server/index.ts` and `src/client/index.ts` stable: other modules import them (`modules/users` uses `AuthRuntime` from `@coreloom/module-auth/server`), and the generated composition imports `createServerComposition` and `createClientContribution`.

Sandbox facts for an edit session (`packages/sandbox/src/server/sessions.ts`): the module is copied to `workspace/modules/<dir>` and a pristine copy to `base/modules/<dir>`; the diff shown to the operator and the eject plan compare the two. The workspace is a pnpm workspace of its own (declared dependencies install for real; a `package.json` change triggers a reinstall that counts as the `dependencies` gate). The business manager updates the spec before implementation. The operator approves the exact spec hash for every affected module; editing that spec, requesting changes, or adding another module reopens its approval gate. An agent never writes `status: approved`, and delivery checks the recorded hash again.

## 2. Classify the change and use its touch list

Change classes: endpoint, table, column, screen, widget, permission, setting, cross-module read, fix.

New endpoint:

1. `src/services/<name>-service.ts`: the method with validation and a stable error code.
2. `src/services/repository.ts` and `sqlite-repository.ts`: interface method and SQL with bound parameters, `WHERE tenant_id = ?` on every tenant-owned query.
3. `src/api/endpoints.ts`: `defineEndpoint` with `access`, `resolveIdentity: endpointIdentityFromContext`, `sessionMutationDenial(octane, auth)` first on mutations, `readJsonObject` plus `requiredString`/`requiredInteger`/`optionalString`; add the route to the returned tuple and its id to `endpoints`.
4. `src/client/api.ts`: the fetch (`content-type: application/json`, `x-csrf-token`, `credentials: 'same-origin'`).
5. `tests/module.test.ts`: service rule tests plus a 401 and a 403 through `route.handler(createContext(...))`, and a tenant isolation case.
6. `spec/module.yaml`: an acceptance scenario, `specVersion` bump.

New column or table:

1. Write `migrations/000N_<module>_<name>.up.sql` first and its documented reverse in `.down.sql`. Never edit, reorder, or remove a migration that shipped. A new table uses `CREATE TABLE IF NOT EXISTS`; a new column uses `ALTER TABLE ... ADD COLUMN` once under the ledger.
2. `src/services/migration.ts`: append `X_MIGRATION_00N` mirroring the `.up.sql` file byte for byte and append its `{ id, statements }` entry to `migrations`. Use `adoptWhen` only when the migration effect cannot be inferred from declared schema objects.
3. `sqlite-repository.ts` continues to call `runModuleMigrations(this.#database, migrations)` once. Extend the row interface and `fromRow`, `INSERT`, `UPDATE` and `SELECT` lists. Add the migration tests required by `migration-authoring`.
4. `src/domain/types.ts`, service, endpoint validation, client form and table column.
5. Tests against `':memory:'` for the new rule; `spec/module.yaml` invariant or scenario, `specVersion` bump.

New permission:

1. `spec/module.yaml` `permissions`: the new `{ id, description }`.
2. `src/acl/permissions.ts`: the constant with the same string.
3. Endpoint `access.permission` and client `scope` on the navigation entry, widget or `canManage` flag.
4. After eject or enable: `pnpm coreloom auth sync-scopes --module <id> --apply` grants it to owners. Members and bundled defaults require a core change in `modules/auth/src/acl/scopes.ts` (`BUNDLED_MODULE_SCOPES`, `MEMBER_SCOPES`); say so in the handoff instead of editing another module.

New screen or widget:

1. `src/client/XView.tsrx` (and `XForm.tsrx` for a drawer) following the pattern in `ux-design`.
2. `src/client/contribution.tsrx`: a `views` entry, a `navigation` entry with a unique id, `viewId`, `group`, `glyph` from `ICON_PATHS`, `scope`, `order`; or a `widgets` entry with a `WORKSPACE_SLOTS` slot. Widget state is its own store instance.
3. `src/client/index.ts`: re-export the view.
4. Add user-facing copy to every declared `translations/*.json` bundle and resolve it with fully qualified `t()` keys. Navigation copy uses getters because contributions exist before bundles are registered.

New setting:

1. `src/settings.ts`: `export const X_MODULE_SETTINGS = defineModuleSettings({ moduleId: '<module>.core', settings: { key: { type: 'string' | 'number' | 'boolean', defaultValue, visibility: 'private' | 'shared', client: boolean, scope: 'tenant' | 'platform', label, description, min?, max?, enum?, secret? } } })` from `@coreloom/kernel` (`packages/kernel/src/module-settings.ts`; keys match `^[a-z][a-zA-Z0-9]*$`).
2. `src/platform.ts`: return `settings: X_MODULE_SETTINGS` next to `routes`; the platform declares it at boot and Administration, Modules renders it in the module's drawer (`modules/system/src/client/ModuleSettingsSection.tsrx`, behind `system.settings.read` and `system.settings.manage`; the API is `GET /api/settings` and `POST /api/settings/update` in `modules/system/src/server/endpoints.ts`).
3. Read it live where it is used: `context.settings.get<number>(tenantId, '<module>.core', 'key')` at request time, never cached at boot; pass `context.settings` into the runtime or service that needs it (`modules/agents/src/settings.ts`, `agentSettings`, shows the pattern with an environment fallback).
4. `spec/module.yaml`: an invariant or scenario naming the setting and its bounds; `specVersion` bump. Cross-module reads of a setting need `visibility: 'shared'` and a declared dependency.

Cross-module read: import the other module's runtime or service type from its public entry (`@coreloom/module-<x>` or `@coreloom/module-<x>/server`), declare `{ "id": "<x>.core", "range": "^0.1.0" }` in `module.json` `dependencies` and the spec, and add the package to `package.json`. Never open its database or import from its `src/` path.

## 3. Versions and spec

Bump `spec/module.yaml` `specVersion`, `module.json` `version` and `package.json` `version` together (patch for a fix, minor for a new endpoint, screen or column). Add an acceptance scenario for every new behaviour and an invariant for every new rule; the scenario id matches `^[A-Z][A-Z0-9-]+$`. In the sandbox the business manager leaves the changed spec in `draft` or `in-review`; only the operator approval route records the approved hash and permits implementation.

## 4. Gates

Sandbox: the role's gates run after the turn. Repository root:

```bash
pnpm --filter @coreloom/module-<dir> typecheck
pnpm --filter @coreloom/module-<dir> test
pnpm coreloom spec validate --all --json
pnpm coreloom module validate --json
pnpm format:check
```

The `dependencies` gate (sandbox) scans imports under `src/`; declare any new package before you import it.

## 5. Landing

Sandbox: eject runs the gates per module, copies added and changed files over the workspace copy and removes the files the session deleted (`packages/sandbox/src/server/delivery/steps.ts`, `removeModuleFiles`), runs `pnpm install`, `auth sync-scopes` for the module, and a platform typecheck; any failed step stops the delivery there. `module enable` runs only for a new module. A session may carry several modules (`modules[]` in `session.json`); each is diffed against its own base and delivered in the same eject. Repository root: `pnpm verify`, then a PR (`release-eject-pr`).

## Pitfalls

- Renaming `createServerComposition`, `createClientContribution` or a permission constant breaks the platform typecheck or another module.
- Editing an applied `.up.sql` file, even only its whitespace, changes its checksum and blocks startup. Add a new numbered migration.
- `ORDER BY` on a new list must be covered by a `(tenant_id, <column>, id)` index.
- A new `Tag` tone or `Icon` name must exist in `@coreloom/ui`; there is no fallback warning.
- Editing `platform/**`, `coreloom.json`, or another module from a module change is out of scope; hand off with the exact core change needed.
