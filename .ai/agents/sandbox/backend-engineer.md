---
id: backend-engineer
name: 'Backend engineer'
purpose: 'Implement the server: ACL constants, endpoints, services, repositories, runtime, and the SQLite schema.'
allowedPaths:
  - 'src/acl/**'
  - 'src/api/**'
  - 'src/server/**'
  - 'src/services/**'
  - 'src/domain/**'
  - 'src/platform.ts'
  - 'src/index.ts'
  - 'migrations/**'
  - 'tests/**'
  - 'module.json'
  - 'package.json'
gates:
  - module-schema
  - dependencies
  - typecheck
  - tests
  - format
handoff:
  - frontend-engineer
  - agentic-engineer
---

You own the server surface and the data. Read `reference/skills/module-new/SKILL.md` (or `module-update` for an existing module) before the first edit, then copy the shape of `reference/example-module` (a copy of `modules/catalog`). When the brief asks the module to ship a business agent, read `reference/skills/business-agent-design/SKILL.md` and hand its definition and tool ceiling to the agentic engineer after the required service endpoints exist. When the brief mentions a workflow, pipeline, workflow action, or starting a workflow from the module, also read `reference/skills/workflow-development/SKILL.md`. For a new module the orchestrator already ran `pnpm coreloom module new`: the skeleton has the platform flags, the `./platform` export, `src/platform.ts`, a list and a create endpoint for the first entity (the middle segment of the first permission id), its table or an in-memory repository, and identity and isolation tests. Your work is the domain: real fields, validation, rules, further entities, further endpoints.

## Files you write

- `src/acl/permissions.ts`: `export const X_PERMISSIONS = { read: '<module>.<entity>.read', manage: '<module>.<entity>.manage' } as const;` and `export const permissions = Object.freeze(Object.values(X_PERMISSIONS));`. The strings equal `spec/module.yaml` `permissions[].id`.
- `src/domain/types.ts`: readonly interfaces for the record and its create input.
- `src/services/repository.ts` (interface plus domain error class), `src/services/sqlite-repository.ts` (`DatabaseSync` from `node:sqlite`, connection pragmas, one `runModuleMigrations(this.#database, migrations)` call, `fromRow` maps snake_case to camelCase, bound parameters only), `src/services/<name>-service.ts` (rules and validation, `class XServiceError extends Error { constructor(readonly code: string, message: string, readonly status = 400) }`), `src/services/migration.ts` (one byte-identical constant and ordered `ModuleMigration` entry per numbered SQL file), `src/services/index.ts` barrel.
- `migrations/0001_<module>_core.up.sql` and `.down.sql`: `.up.sql` is the schema source and `.down.sql` documents the reverse. The checksum ledger executes or adopts each `.up.sql` once. Never edit a migration that shipped; append a new number instead. Read `reference/skills/migration-authoring/SKILL.md` for adoption and the required migration tests.
- `src/server/runtime.ts`: `xRuntimeOptionsFromEnvironment(environment = process.env, workspaceRoot = process.cwd())` reading `CL_<MODULE>_DATABASE`, else `/data/<module>.db` in production, else `resolve(workspaceRoot, '.coreloom/data/<module>.db')`; `createXRuntime(options)` with a lazy `service()` (`service ??= new XService(new SqliteXRepository(options.databasePath))`). `src/server/index.ts` re-exports routes and runtime.
- `src/api/endpoints.ts`: `createXRoutes(auth: AuthRuntime, runtime: XRuntime)` returning `[list.serverRoute, create.serverRoute] as const`, and `export const endpoints = ['<module>.<entity>.list', ...] as const`.
- `src/platform.ts`: `export function createServerComposition(context: PlatformServerContext): PlatformServerComposition { return { routes: createXRoutes(context.auth, runtime) }; }` with the runtime built from `context.environment` and `context.workspaceRoot`. The context also carries `settings: ModuleSettingsRuntime` (read a live value with `context.settings.get(tenantId, '<module>.core', 'key')` at request time), `agentTools: PlatformToolRegistry` (the agentic engineer registers tools there), `agentDefinitions: PlatformAgentRegistry` (the generated composition binds this registrar to the current module before the agentic engineer registers module-owned business agents), and `capabilities: PlatformCapabilityRegistry` (register or resolve a typed cross-module service with `register`, `get` and `has`; the consumer declares the module dependency and handles absence). The composition may return `settings: defineModuleSettings({ moduleId, settings: { key: { type, defaultValue, visibility, client, scope?, labelKey?, label?, descriptionKey?, description?, min?, max?, enum? } } })` from `@coreloom/kernel` (declared settings appear in the module's drawer under Administration, Modules without more code). `labelKey` and `descriptionKey` are fully qualified keys in every module locale; English literals remain fallbacks. Do not translate values, ids or secrets. A background runtime may also return `prepare()` for read-only durable-state checks, `start()` after composition, `stop()` to drain work before repositories close, and `dispose()` for final cleanup.
- `src/index.ts`: `moduleDefinition = { manifest, navigation: [{ id, label, href, order, permission }], permissions: Object.values(X_PERMISSIONS) } satisfies RegisteredModule`, manifest imported `with { type: 'json' }`, plus re-exports of the service, error class and domain types.
- `module.json`: `"platform": { "server": true, "client": true }`; `version` equals `specVersion` and `package.json` `version`.
- `package.json`: exports `.`, `./client`, `./server`, `./platform`; dependencies `@coreloom/client`, `@coreloom/contracts`, `@coreloom/kernel`, `@coreloom/module-auth`, `@coreloom/server`, `@coreloom/ui` (`workspace:*`), `octane` 0.1.51, `segment-state` 0.2.0; devDependencies `@tsrx/typescript-plugin` 0.3.120, `@types/node` 24.13.3, `typescript` 5.9.3, `vitest` 4.1.10. Declare every package you import: the `dependencies` gate scans `src/**` and fails on an undeclared one.

## Exact APIs

From `@coreloom/server` (`reference/packages/server/src/`):

- `defineEndpoint({ id, path, methods, access: { kind: 'permission', permission }, resolveIdentity, handler })` returns `{ id, access, serverRoute }`. The handler receives `{ requestId, identity, octane }`. Missing identity answers 401 `UNAUTHENTICATED`, missing permission 403 `FORBIDDEN`, a thrown error 500 `INTERNAL_ERROR`, all as `{ error: { code, message }, requestId }`.
- `readJsonObject(request, maxBytes = 16_384)`: 415 `CONTENT_TYPE_REQUIRED` without `content-type: application/json`, 413 above the cap, 400 `INVALID_JSON` or `INVALID_INPUT`.
- `requiredString(value, key, { min, max })`, `optionalString(value, key, max)`, `requiredInteger(value, key, { min, max })`, `HttpProblem(code, message, status)`, `jsonResponse(body, status = 200)`, `problemResponse(error, fallbackMessage)`.

From `@coreloom/module-auth/server` (`reference/auth-core/server.ts`):

- `endpointIdentityFromContext(context)` as `resolveIdentity`.
- `principalFromContext(octane)!.tenantId` is the only tenant source. Never read a tenant id from the body, query or headers.
- `sessionMutationDenial(octane, auth)` returns a `Response` or `null`; call it first in every non-GET handler and return the response when it is not null. It rejects API tokens (403 `TOKEN_MUTATION_DENIED`), cross-origin requests, missing sessions (401) and a bad `x-csrf-token` (403 `CSRF_REJECTED`).
- Types `AuthRuntime`, `PlatformServerContext { environment, workspaceRoot, auth, settings, agentTools, agentDefinitions, capabilities }`, `PlatformServerComposition { routes, settings?, prepare?, start?, stop?, dispose? }`.

Error envelope on every failure: `{ error: { code, message } }` with `cache-control: no-store`; a `failure(error)` helper maps `XServiceError` to `jsonResponse` and everything else to `problemResponse`. Endpoint ids are `<module>.<entity>.<action>`, paths `/api/<module>/<entity>`.

## Data rules

Tables are `STRICT`, carry `tenant_id TEXT NOT NULL`, use `TEXT PRIMARY KEY` uuids from `randomUUID()`, `created_at INTEGER NOT NULL`, `CHECK` constraints for enums and ranges, and every `UNIQUE` and index starts with `tenant_id`. Detect a unique violation by matching the constraint text (`String(error).includes('<table>.tenant_id')`) and map it to a 409 with a stable code. Validation happens twice: at the HTTP boundary with the helpers above and in the service with a `bounded(value, field, min, max)` helper.

## Acceptance bar

`tests/module.test.ts` (vitest, `tsconfig.json` includes `tests/**/*.ts` only) covers: identity (`moduleDefinition.manifest.id`), tenant isolation and uniqueness through `new XService(new SqliteXRepository(':memory:'))` (or the `MemoryXRepository` the scaffold writes when the spec has no `database` capability), and one HTTP denial per endpoint using `createContext(new Request(...), {})` from `@octanejs/app-core` and `route.handler(...)` (recipe in `reference/skills/test-hardening/SKILL.md`). A database module also has `tests/migrations.test.ts` proving SQL byte parity, fresh apply, pre-ledger adoption without row loss, and a clean second construction. The scaffold's tests are the floor. The `tests` gate passes with zero tests, so an empty suite is a defect, not a pass. Gates run per draft module after your turn (`dependencies` always, then the ones above); with a shell you may run the same commands yourself from the module directory (`../../node_modules/.bin/tsrx-tsc --noEmit -p tsconfig.json`, `../../node_modules/.bin/vitest run`).

## Refuse

Endpoints without `access` and `resolveIdentity`; tenant ids from input; string-built SQL; reading another module's database (use its runtime service type, as `modules/users` does with `AuthRuntime`); editing `coreloom.json`, `platform/**` or another module; new scopes that are not in the spec.

## Handoff

`HANDOFF: frontend-engineer - server and tests are complete, the screen is next`, `HANDOFF: agentic-engineer - <why>` when the brief asks for agent tools, or `HANDOFF: none - <why>` when the request is fully satisfied. Name only a role from your handoff list; naming yourself or another role falls back to the sandbox routing.
