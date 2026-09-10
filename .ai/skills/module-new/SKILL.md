---
name: module-new
description: >-
  Create a Flowdular module from an approved spec, from scaffold to enabled and
  granted, with the file set and APIs .ai/references/catalog uses.
roles:
  - business-manager
  - backend-engineer
  - frontend-engineer
  - ux-designer
  - agentic-engineer
  - module-executor
when: A brief asks for a module that does not exist yet, or a sandbox session is labelled new-module.
---

# Create a module

The reference module is `.ai/references/catalog` (in a sandbox session: `reference/example-module`). When this skill and the code disagree, the code wins; tell the operator.

Two ways to land the same module: the sandbox (a brief, specialist turns, gates after every turn, preview, eject) or the direct path (this skill in your own coding tool, the gates by hand, `pnpm verify`, a pull request). The sections below mark the differences.

## 1. Preconditions

- `pnpm flowdular doctor --json` reports `status: healthy` (repository root only; the sandbox runs gates for you).
- `modules/<dir>/spec/module.yaml` exists, validates (`pnpm flowdular spec validate --all --json`) and has `status: approved`. `pnpm flowdular module new` refuses a draft with `A module can only be created from an approved specification.` In the sandbox the operator approves the spec after the business manager's turn, and the orchestrator runs the scaffold itself. Outside the sandbox, a host agent may record approval only after an explicit current user request and only through `spec-approval`.
- Ids: module id and every permission id match `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. `inventory.core` lives in `modules/inventory` as `@flowdular/module-inventory` (`packages/cli/src/module-scaffold.ts`, `packageSuffix`). Module environment variables use the upper-case directory (`modules/auth` reads `FD_AUTH_SECURE_COOKIE`); the database is platform-owned, so a module never gets one of its own.

## 2. Scaffold

```bash
pnpm flowdular module new inventory.core --spec modules/inventory/spec/module.yaml          # dry run, lists files
pnpm flowdular module new inventory.core --spec modules/inventory/spec/module.yaml --apply
```

`packages/cli/src/module-templates.ts` (`planScaffold`) writes a module the generated composition can import, formatted with the workspace Prettier: `module.json` with `platform.{server,client}` from the capabilities, `package.json` with the `.`, `./client`, `./server`, `./platform` exports and pinned versions, `tsconfig.json` with `types: ["node"]`, the spec copy, `src/index.ts`, `src/acl/permissions.ts` (`X_PERMISSIONS` built from the spec `permissions`), `src/domain/types.ts`, `src/services/{repository,<suffix>-service,index}.ts`, `src/api/endpoints.ts`, and then by capability: `database` gives `src/services/{migration,database-repository}.ts` plus the PostgreSQL `migrations/0001_<snake>_core.{up,down}.sql`, otherwise `src/services/memory-repository.ts`; `api` gives `src/server/{runtime,index}.ts` and `src/platform.ts` with `createServerComposition`; `client` gives `src/client/{index.ts,contribution.tsrx,<Pascal>View.tsrx}` plus `api.ts` and `state.ts` when a read permission exists; `cli` gives `src/cli/{commands.json,index.ts}`; always `tests/module.test.ts` (identity and tenant isolation) and `translations/<locale>.json` (`pl` gets the placeholder `Moduł <name>`).

The scaffold is PostgreSQL from the first commit. `database-repository.ts`
exports `Database<Name>Repository` and `migrate<Name>Database`, takes a
`DatabaseHandle`, wraps every async method in
`database.transaction(..., { tenantId, access })`, binds `$1`, `$2` parameters,
and normalizes integer columns through a local `integer()` helper because
PostgreSQL returns `BIGINT` as a string. `migrations/0001_<snake>_core.up.sql`
creates the table with forced row-level security and a tenant policy. The
runtime takes `context.databases`, acquires a `migration` lease, runs the
migrations, releases it, then acquires the runtime lease requiring
`DATABASE_DIALECT_IDS.postgresql`. `tests/module.test.ts` runs on
`createPgliteTestProvider()` and asserts tenant isolation. The business repository port
stays async and database-agnostic, and persistence stays on
`@flowdular/database`.

The first entity is the middle segment of the first permission id (`inventory.locations.read` gives `locations`, table `inventory_locations`, type `InventoryLocation`); it gets the list endpoint (`.read`), the create endpoint (`.manage`), the table, the view and the tests. Every other permission becomes a constant in `X_PERMISSIONS` only; its entity is `module-update` work. A directory that already holds `spec/module.yaml` and `translations/**` (the business manager's files) is extended, and those files win over the scaffold's; a directory with sources is refused. In the sandbox the orchestrator runs the scaffold once the spec is approved.

What is still yours after the scaffold: the real fields of the entity beyond `name`, validation bounds and stable error codes, uniqueness rules and their indexes, further endpoints and entities, screen columns and the drawer form, tests beyond identity and isolation. A business agent is a separate phase using `business-agent-design`; the scaffold does not invent one.

## 3. Server file set

Copy the HTTP and domain layout of `.ai/references/catalog/src`, and the persistence shape of `modules/profile/src/services/database-repository.ts`. Keep three layers: an async database-agnostic repository port, module-owned persistence and PostgreSQL SQL, and the platform-owned driver provider. Exact endpoint signatures:

```ts
// src/api/endpoints.ts
import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';

const create = defineEndpoint({
	id: 'inventory.locations.create',
	path: '/api/inventory/locations',
	methods: ['POST'],
	access: { kind: 'permission', permission: INVENTORY_PERMISSIONS.manage },
	resolveIdentity: endpointIdentityFromContext,
	handler: async ({ octane }) => {
		const denial = sessionMutationDenial(octane, auth);
		if (denial) return denial;
		try {
			const value = await readJsonObject(octane.request);
			const input = { code: requiredString(value, 'code', { max: 32 }) };
			const tenantId = principalFromContext(octane)!.tenantId;
			return jsonResponse(
				{ location: await runtime.service().create(tenantId, input) },
				201,
			);
		} catch (error) {
			return failure(error);
		}
	},
});
```

`createXRoutes(auth: AuthRuntime, runtime: XRuntime)` returns `[list.serverRoute, create.serverRoute] as const`. `src/platform.ts` (the scaffold writes this; extend it):

```ts
import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createInventoryRuntime({ databases: context.databases });
	return {
		routes: createInventoryRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
```

`PlatformServerContext` also carries `databases: DatabaseProvider`, `settings: ModuleSettingsRuntime`, `agentTools: PlatformToolRegistry`, `agentDefinitions: PlatformAgentRegistry`, and `capabilities: PlatformCapabilityRegistry`. The runtime shares one lazy database initialization, uses separate migration and runtime leases, and releases the runtime lease from `dispose()`; `prepare()` remains read-only. A composition may return module settings, lifecycle hooks, agent registrations, and typed cross-module capabilities as described in the focused skills.

Schema: write PostgreSQL SQL in `migrations/0001_inventory_core.up.sql` and mirror it byte for byte in `databaseMigrations` as `sql: { postgresql: ... }` with an `inspectExisting` built from `postgresTenantTableState(...)`. Tenant tables enable and force row-level security with an `<table>_tenant_policy` whose `USING` and `WITH CHECK` compare `tenant_id` with `current_setting('coreloom.tenant_id', true)`; the runtime role has no superuser or `BYPASSRLS`. Repository operations use `database.transaction(..., { tenantId, access })` and retain explicit tenant predicates. Details in `migration-authoring` and `database-adapter`.

Errors: `{ error: { code, message } }`; service errors `class XServiceError extends Error { constructor(readonly code: string, message: string, readonly status = 400) }`; a `failure(error)` helper routes them to `jsonResponse(..., error.status)` and everything else to `problemResponse(error, 'The <module> operation failed.')`.

## 4. Client file set

`src/client/{index.ts,contribution.tsrx,api.ts,state.ts,XView.tsrx,XForm.tsrx}`. The canonical entry:

```ts
// src/client/index.ts
import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { createInventoryClientContribution as canonicalContribution } from './contribution.tsrx';
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
```

Contribution rules (`packages/client/src/contributions.ts`): `navigation[].group` in `Workspace`, `Operations`, `Agents`, `Administration`, `Development` (`Agents` only with an `agents.core` dependency, `Development` is owner-only in the shell); `widgets[].slot` in `WORKSPACE_SLOTS` (`dashboard.metrics`, `dashboard.main`, `dashboard.aside`, `topbar.actions`); `glyph` an `ICON_PATHS` key (`packages/ui/src/icons/Icon.tsrx`, list in `ux-design`); ids `<module>.navigation`, `<module>.dashboard.<name>`, view id equals the URL slug; `accountMenu` for personal screens (`modules/profile`). Duplicate ids or a navigation entry pointing at a missing view throw at boot.

State and data: `useMemo(() => createXClientState(), [])` per component, `cell<T>()` for typed fields, `const [items] = useValue(state.items)`, `store.act((transaction) => transaction.set(state.items, records), 'inventory/loaded')`. Mutations send `content-type: application/json`, `x-csrf-token`, `credentials: 'same-origin'`. `Kpi.value` is a string. Screen and form pattern: `ux-design`.

## 5. Tests and local gates

`tests/module.test.ts` (vitest): identity, tenant isolation and uniqueness against a `createPgliteTestProvider()` lease, and one denial per endpoint through `route.handler(createContext(request, {}))` (`test-hardening`). Then, from the repository root:

```bash
pnpm --filter @flowdular/module-inventory typecheck     # tsrx-tsc --noEmit -p tsconfig.json
pnpm --filter @flowdular/module-inventory test          # vitest run
pnpm flowdular module validate --json
pnpm flowdular spec validate --all --json
pnpm format:check
```

`module validate` (`packages/cli/src/module-validate.ts`) also checks the composition contract: `PLATFORM_SERVER_ENTRY_MISSING` and `PLATFORM_EXPORT_MISSING` (no `src/platform.ts` or `./platform` export behind `platform.server`), `PLATFORM_CLIENT_ENTRY_MISSING` and `PLATFORM_CLIENT_EXPORT_MISSING`, `PACKAGE_NAME_MISMATCH`, `SPEC_ID_MISMATCH`, `TRANSLATION_FILE_MISSING`, `TRANSLATION_KEYS_MISMATCH`, and the warnings `SPEC_VERSION_DRIFT` and `LOCALE_NOT_IN_PROJECT`.

Sandbox gates (`packages/sandbox/src/server/gates.ts`): `spec-schema` and `module-schema` once per session workspace; `dependencies`, `typecheck`, `tests` (`vitest run --passWithNoTests`, so no tests still passes) and `format` (`prettier --check .`) once per draft module with the module's own binaries. The session workspace is a real pnpm workspace that installs what each draft `package.json` declares, so an undeclared import fails the `dependencies` gate, which runs after every turn that changed files. A driver with a shell may run the same commands from the module directory; the sandbox runs them again after the turn and feeds a failure back into the fix prompt.

## 6. Enable

```bash
pnpm flowdular module enable inventory.core --apply
```

One command (`packages/cli/src/runner.ts`, `module enable`): adds the id to `flowdular.json` `modules.enabled`, adds the package to `platform/package.json`, runs `pnpm install` when the package is not linked, regenerates `platform/src/generated/modules.{server,client}.ts`, and then runs `auth sync-scopes` for the module, reporting the grant as `scopes` in the result; a failed grant is `MODULE_SCOPES_SYNC_FAILED` with the module already enabled. Never edit those files by hand. `pnpm flowdular auth sync-scopes --module inventory.core --apply` stays the way to re-grant later (a new permission, a new owner, a deployment database): it grants the spec's `permissions[].id` to the owners of every tenant (`modules/auth/src/services/auth-service.ts`, `grantModuleScopes`). Members never receive new scopes automatically; a module bundled with the platform also adds its scopes to `BUNDLED_MODULE_SCOPES` and, for read scopes, `MEMBER_SCOPES` in `modules/auth/src/acl/scopes.ts` (a core change). The sandbox eject runs enable for each new module and sync-scopes for each module (`packages/sandbox/src/server/delivery/local.ts`).

## Pitfalls

- 415 on every POST: the client did not send `content-type: application/json` (`readJsonObject`).
- 403 `CSRF_REJECTED` or `ORIGIN_REQUIRED`: `x-csrf-token` missing or the request is not same-origin.
- Module enabled but no navigation: scopes not granted, or `platform.client` missing.
- Routes 404: `platform.server` missing, no `./platform` export, or `src/platform.ts` absent; `pnpm flowdular module validate` names it (`PLATFORM_*`).
- `Kpi` typecheck error: `value` must be a string.
- Register every `translations/*.json` bundle in the client contribution, put all user-facing copy there with matching key sets, and resolve it with `t()` as described by `translations-i18n`.
- Every relative import needs its `.ts` or `.tsrx` extension.
- `module.json` `version`, `spec` `specVersion` and `package.json` `version` are one number.
