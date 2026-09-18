---
name: module-update
description: >-
  Change an existing module (endpoint, table, screen, permission, widget) with
  the fixed touch list per change class and the version bump rules.
---
# Update an existing module

## Spec is the contract

With an approved `schemaVersion: 2` spec delta, the specification is the requirement document. Read the spec, the module itself, the touch list for the change class below, and `.ai/references/catalog` for shape. Do not scan `modules/` or `packages/`: `.ai/platform-capabilities.md` answers what the platform provides.

Anything the delta does not say is a spec defect, not your decision. Report it back (`HANDOFF: business-manager - <what is missing>` in the sandbox, a question to the user on a host) instead of guessing, and never implement an item the spec parks in `outOfScope[]`. Every new or changed `acceptanceScenarios[]` entry maps to at least one test, with the scenario id in the test name.

The spec-element to file mapping is the table in `module-new`; the change classes below are the same mapping arranged by what you are changing.

## 1. Read first

Read the whole module before changing it: `spec/module.yaml`, `src/index.ts`, `src/acl/permissions.ts`, `src/api/endpoints.ts`, `src/services/*`, `src/client/*`, `tests/`. Keep every exported name in `src/index.ts`, `src/server/index.ts` and `src/client/index.ts` stable: other modules import them (`modules/users` uses `AuthRuntime` from `@flowdular/module-auth/server`), and the generated composition imports `createServerComposition` and `createClientContribution`.

Sandbox facts for an edit session (`packages/sandbox/src/server/sessions.ts`): the module is copied to `workspace/modules/<dir>` and a pristine copy to `base/modules/<dir>`; the diff shown to the operator and the eject plan compare the two. The workspace is a pnpm workspace of its own (declared dependencies install for real; a `package.json` change triggers a reinstall that counts as the `dependencies` gate). The business manager updates the spec before implementation. The operator approves the exact spec hash for every affected module; editing that spec, requesting changes, or adding another module reopens its approval gate. A sandbox specialist never writes `status: approved`; a host agent may invoke approval only after an explicit current user request through `spec-approval`. Delivery checks the recorded hash again.

## 2. Classify the change and use its touch list

Change classes: endpoint, table, column, screen, widget, permission, setting, cross-module read, agent tool, business agent, research, adapter, template, fix.

New endpoint:

1. `src/services/<name>-service.ts`: the method with validation and a stable error code.
2. `src/services/repository.ts` and `database-repository.ts`: the async interface method and SQL with `$1`, `$2` parameters, `WHERE tenant_id = $1` on every tenant-owned query, inside `database.transaction(..., { tenantId, access })`.
3. `src/api/endpoints.ts`: `defineEndpoint` with `access`, `resolveIdentity: endpointIdentityFromContext`, `sessionMutationDenial(octane, auth)` first on mutations, `readJsonObject` plus `requiredString`/`requiredInteger`/`optionalString`; add the route to the returned tuple and its id to `endpoints`.
4. `src/client/api.ts`: the fetch (`content-type: application/json`, `x-csrf-token`, `credentials: 'same-origin'`).
5. `tests/module.test.ts`: service rule tests plus a 401 and a 403 through `route.handler(createContext(...))`, and a tenant isolation case.
6. `spec/module.yaml`: an acceptance scenario, `specVersion` bump.

New column or table:

1. Write `migrations/000N_<module>_<name>.up.sql` first and its documented reverse in `.down.sql`. Never edit, reorder, or remove a migration that shipped. A new table uses `CREATE TABLE IF NOT EXISTS`; a new column uses `ALTER TABLE ... ADD COLUMN` once under the ledger.
2. `src/services/migration.ts`: append `X_MIGRATION_00N` mirroring the `.up.sql` file byte for byte and append its `{ id, sql: { postgresql: X_MIGRATION_00N }, inspectExisting }` entry to `databaseMigrations`. Build `inspectExisting` from `postgresTenantTableState(...)` so a mixed state returns `partial`.
3. `database-repository.ts`: extend the row interface and `fromRow`, the `INSERT`, `UPDATE` and `SELECT` lists, and the `integer()` normalization for a new integer column. Migrations run from the runtime's `migration` lease, not from the repository. Add the migration tests required by `migration-authoring`.
4. `src/domain/types.ts`, service, endpoint validation, client form and table column.
5. Tests against the module's `tests/support/database.ts` provider for the new rule; `spec/module.yaml` invariant or scenario, `specVersion` bump.

New permission:

1. `spec/module.yaml` `permissions`: the new `{ id, description }`.
2. `src/acl/permissions.ts`: the constant with the same string.
3. Endpoint `access.permission` and client `scope` on the navigation entry, widget or `canManage` flag.
4. After eject or enable: `pnpm flowdular auth sync-scopes --module <id> --apply` grants it to owners. Members and bundled defaults require a core change in `modules/auth/src/acl/scopes.ts` (`BUNDLED_MODULE_SCOPES`, `MEMBER_SCOPES`); say so in the handoff instead of editing another module.

New screen or widget:

1. `src/client/XView.tsrx` (and `XForm.tsrx` for a drawer) following the pattern in `ux-design`.
2. `src/client/contribution.tsrx`: a `views` entry, a `navigation` entry with a unique id, `viewId`, `group`, `glyph` from `ICON_PATHS`, `scope`, `order`; or a `widgets` entry with a `WORKSPACE_SLOTS` slot. Widget state is its own store instance.
3. `src/client/index.ts`: re-export the view.
4. Add user-facing copy to every declared `translations/*.json` bundle and resolve it with fully qualified `t()` keys. Navigation copy uses getters because contributions exist before bundles are registered.

New feature flag: a setting with `kind: 'flag'`, `type: 'boolean'`, `scope: 'tenant'` and a `defaultValue`. It reads like any other setting, `context.settings.get<boolean>(tenantId, '<module>.core', 'key')`, and appears on the Flags tab of Administration, Modules beside the module's other flags; a change is audited as `settings.flag.changed`. Declare it in the spec as `kind: flag` too, and state in an invariant what the module does while it is off. Before changing behaviour a workspace already relies on, removing a step, or adding an outward-facing or costly path, propose a flag and let the operator decide: ship the new path behind it, default off, and keep the old path working while it is off. A flag is on or off for one workspace; there is no percentage rollout and no targeting.

New setting:

1. `src/settings.ts`: `export const X_MODULE_SETTINGS = defineModuleSettings({ moduleId: '<module>.core', settings: { key: { type: 'string' | 'number' | 'boolean', kind?: 'flag', defaultValue, visibility: 'private' | 'shared', client: boolean, scope: 'tenant' | 'platform', labelKey, label, descriptionKey, description, min?, max?, enum?, secret? } } })` from `@flowdular/kernel` (`packages/kernel/src/module-settings.ts`; setting keys match `^[a-z][a-zA-Z0-9]*$`). `labelKey` and `descriptionKey` are fully qualified module translation keys present in every locale. Keep the English literals as compatibility fallbacks; values, ids and secrets are never translated.
2. `src/platform.ts`: return `settings: X_MODULE_SETTINGS` next to `routes`; the platform declares it at boot and Administration, Modules renders it in the module's drawer (`modules/system/src/client/ModuleSettingsSection.tsrx`, behind `system.settings.read` and `system.settings.manage`; the API is `GET /api/settings` and `POST /api/settings/update` in `modules/system/src/server/endpoints.ts`).
3. Read it live where it is used: `context.settings.get<number>(tenantId, '<module>.core', 'key')` at request time, never cached at boot; pass `context.settings` into the runtime or service that needs it (`modules/agents/src/settings.ts`, `agentSettings`, shows the pattern with an environment fallback).
4. `spec/module.yaml`: an invariant or scenario naming the setting and its bounds; `specVersion` bump. Cross-module reads of a setting need `visibility: 'shared'` and a declared dependency.

Cross-module read: import the other module's runtime or service type from its public entry (`@flowdular/module-<x>` or `@flowdular/module-<x>/server`), declare `{ "id": "<x>.core", "range": "^0.1.0" }` in `module.json` `dependencies` and the spec, and add the package to `package.json`. Never open its database or import from its `src/` path.

Agent tool: use `agent-tool-design` as a separate phase; add the approved scenario, `src/agent/tools.ts`, the `context.agentTools.register(...)` call, target-side idempotency for writes, and denial tests.

Business agent: use `business-agent-design` as a separate phase; add the approved behavior and refusal scenarios, declare the `agents.core` module and package dependencies, define it in `src/agent/agents.ts`, and register it with `context.agentDefinitions.register(...)`. A code definition owns behavior and a maximum exact tool allowlist. Provider, model, active state, and the reduced enabled tools remain tenant binding data.

Research (a `research` section):

1. `spec/module.yaml`: the section, `research.search.v1`, `research.fetch.v1` or `research.evidence.v1` under `requires`, `research.core` under `dependencies`, a scenario where a finding without evidence is refused; `specVersion` bump.
2. `src/research.ts`: the declaration, in the shape `module new` writes (`RESEARCH_CAPABILITIES` and `<CONSTANT>_RESEARCH ... as const satisfies ModuleSpecResearch`), and `research-fixtures.json` with the queries and pages the scenarios need.
3. The service that stores a finding on the `evidenceOwner` record: an `evidenceIds` input, each id checked with `get(tenantId, id)` on `research.evidence.v1`, `attach(tenantId, '<module id>', recordId, evidenceIds)` before the finding commits; the record screen lists `list(...)` and links `workspaceViewHref('research-evidence') + '?id=' + id`.
4. `module.json` `requires` and `dependencies`, `package.json` `@flowdular/module-research`.
5. Tests on faked capabilities: a finding without evidence and an evidence id of another tenant are refused.

Adapter (an `adapters[]` entry): `spec/module.yaml` with the entry (and `recorded` in a sandbox session) and a `specVersion` bump; `src/adapters/<name>.ts` in the shape `module new` writes; then the connector definition, the port or list export, the run table migration, the job runner in `src/platform.ts`, the tenant setting holding the instance id, `adapters/<name>.recorded.json` and the tests as a separate `integration-adapter` phase.

Template (a `templates[]` entry): `spec/module.yaml` with the entry, `documents.templates.v1` under `requires`, `documents.core` (`^0.3.0`) under `dependencies`, a scenario that a render without the module's record permission is refused, `specVersion` bump; `templates/<name>.md` in the template language reading only fields of `inputEntity`; `templates` in `package.json` `files` and `@flowdular/module-documents` in `dependencies`; `src/templates.ts` with `{ key: '<module id>.<name>', title, format, locale, body, inputSchema: templateInputSchemaFromFields(<entity fields>), layout }`, the body mirrored byte for byte from the `.md` file with a test comparing them and a test registering them into `new DocumentTemplateRegistry()` (`@flowdular/module-documents/server`); `context.capabilities.get<DocumentTemplates>(DOCUMENTS_TEMPLATES_CAPABILITY)?.register('<module id>', TEMPLATES)` in `src/platform.ts`; the action that renders checks its own record permission, then calls `render({ tenantId, principal: { accountId, scopes }, ownerModule: '<module id>', recordRef, templateKey, input })` and reads `status(tenantId, jobId)` for a queued render. `module-new` section 4b carries the language.

## 3. Versions and spec

Bump `spec/module.yaml` `specVersion`, `module.json` `version` and `package.json` `version` together with `pnpm flowdular module version bump <id> <patch|minor|major> --apply` (patch for a fix, minor for a new endpoint, screen, column, adapter, template or research section); it also retargets every dependent `^` range that stops matching. A new `context.capabilities.register` id goes under `provides` in `module.json`; a new `context.capabilities.get` id goes under `requires`. Add an acceptance scenario for every new behaviour and an invariant for every new rule; the scenario id matches `^[A-Z][A-Z0-9-]+$`. In the sandbox the business manager leaves the changed spec in `draft` or `in-review`; only the operator approval route records the approved hash and permits implementation.

## 4. Gates

Sandbox: the role's gates run after the turn. Repository root:

```bash
pnpm --filter @flowdular/module-<dir> typecheck
pnpm --filter @flowdular/module-<dir> test
pnpm flowdular spec validate --all --json
pnpm flowdular module validate --json
pnpm format:check
```

The `dependencies` gate (sandbox) scans imports under `src/`; declare any new package before you import it.

## 5. Landing

Sandbox: eject runs the gates per module, copies added and changed files over the workspace copy and removes the files the session deleted (`packages/sandbox/src/server/delivery/steps.ts`, `removeModuleFiles`), runs `pnpm install`, `auth sync-scopes` for the module, and a platform typecheck; any failed step stops the delivery there. `module enable` runs only for a new module. A session may carry several modules (`modules[]` in `session.json`); each is diffed against its own base and delivered in the same eject. Repository root: `pnpm verify`, then a PR (`release-eject-pr`).

## Pitfalls

- Renaming `createServerComposition`, `createClientContribution` or a permission constant breaks the platform typecheck or another module.
- Editing an applied `.up.sql` file, even only its whitespace, changes its checksum and blocks startup. Add a new numbered migration.
- `ORDER BY` on a new list must be covered by a `(tenant_id, <column>, id)` index.
- A new `Tag` tone or `Icon` name must exist in `@flowdular/ui`; there is no fallback warning.
- Editing `platform/**`, `flowdular.json`, or another module from a module change is out of scope; hand off with the exact core change needed.
