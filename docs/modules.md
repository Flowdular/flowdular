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

`schemaVersion: 2` adds the domain model, so an implementing agent reads the
spec instead of scanning the repository. Every section is optional and a
`schemaVersion: 1` spec stays valid unchanged; version 1 rejects these keys.

- `entities[]`: `id`, `name`, `fields[]` (`id`, `type` of `string`, `text`,
  `integer`, `decimal`, `boolean`, `date`, `datetime`, `enum`, `reference` or
  `json`, plus `required`, `unique: tenant|none`, `maxLength`, `values` for an
  enum, `reference` as `<entityId>` or `<moduleId>.<entityId>`), and optional
  `states` (`field`, `values`, `transitions`).
- `screens[]`: `id`, `kind` of `list`, `record`, `form` or `dashboard`,
  `entity`, `title`, `columns`, `filters`, `navigationGroup`.
- `actions[]`: `id`, `entity`, `permission`, `kind`, `risk`, `idempotent`,
  `description`. `widgets[]`: `id`, `slot`, `entity`, `description`.
- `settings[]`: `key`, `type`, `scope`, `default`, `values`, `description`.
  `agentTools[]`: `id`, `permission`, `description`, `risk`.
- `outOfScope[]` records what is deliberately not built; `decisions[]` records
  each interview question, its answer and whether a user or a default decided.

Validation is more than the schema: an action permission must exist in
`permissions`, every `entity` must name an entity, screen `columns` and
`filters` must be fields of that entity, a `reference` must resolve in this spec
or a declared dependency, an enum field or setting needs `values`, `states.field`
must be the enum that declares exactly `states.values`, a field may not be called
`id`, `tenantId`, `createdAt` or a PostgreSQL reserved word such as `order` or
`user` (generated SQL quotes no identifier), and the `database` capability needs
at least one entity (`SPEC_ACTION_PERMISSION_UNKNOWN`, `SPEC_ENTITY_UNKNOWN`,
`SPEC_FIELD_UNKNOWN`, `SPEC_FIELD_RESERVED`, `SPEC_STATE_FIELD_INVALID`,
`SPEC_REFERENCE_UNKNOWN`, `SPEC_ENUM_VALUES_REQUIRED`, `SPEC_ENTITY_REQUIRED`,
`SPEC_DUPLICATE_ID`). A client without a list screen, or a stored entity with no
tenant-unique field, is a warning.

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

From a `schemaVersion: 2` spec one entity replaces the demo record: the one
whose id matches the permission entity segment, else the first declared. Its
fields become `src/domain/types.ts`, the `0001` migration columns (with
`UNIQUE (tenant_id, …)` for a `unique: tenant` field), the repository row
mapping, the create endpoint's input validation (required fields only; the
lifecycle field is set by the service), and the columns of the first `list`
screen become the table view. Further entities are the implementing agent's
work.

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

## Versions, ranges and capabilities

A module carries one version in three places: `module.json` `version`,
`package.json` `version` and `spec/module.yaml` `specVersion`. Bump them with
one command; it also rewrites every dependent range that stops accepting the
new version and keeps the operator (`^0.11.0` becomes `^0.12.0`):

```sh
pnpm flowdular module version auth.core
pnpm flowdular module version bump auth.core minor --apply
```

Dependency ranges use caret (`^0.11.0`). Below 1.0.0 a caret range accepts
patch releases only, so a minor bump of a core module still moves its
dependents, which the bump command does. `module validate` reports
`SPEC_DEPENDENCY_DRIFT` when the spec and manifest ranges differ and
`PLATFORM_API_MISSING` when a manifest lacks `platformApi`.

`platformApi` is the range of the platform contract the module compiles against
(`^0.1.0`). The contract surface is pinned in
`packages/kernel/platform-api.snapshot.d.ts`; a change to it without a
`PLATFORM_API_VERSION` bump fails `pnpm verify`. `module search --compatible`
lists only releases whose range accepts the running platform.

Cross-module services are declared by capability id, not by module version:
`provides` lists the ids a module registers, `requires` lists the ids it
resolves (`optional: true` when it handles absence). The kernel orders required
providers before consumers, refuses a missing provider or two providers of one
id, and the composition hands each module a registry view that accepts only its
declared ids. The installer resolves a required capability to the newest
compatible release that provides it.

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

## Record policies

A permission says who may act on a kind of record. A policy says whether this
record allows it: an amount above an approver's limit, a claim the submitter
owns, a contract outside the reviewer's region. Policies are declared with
`definePolicy` from `@flowdular/kernel` and evaluated through a registry the
module fills while it composes:

```ts
const amountLimit = definePolicy<Claim>({
	id: 'expenses.claims.amount-limit',
	permission: 'expenses.claims.approve',
	evaluate: ({ record }) =>
		record.amountMinor <= 100_000
			? { allowed: true }
			: {
					allowed: false,
					reason: 'The claim exceeds the approver limit.',
					requiresApproval: {
						requirement: { roleKey: 'finance-lead', decisions: 2 },
					},
				},
});

const policies = createPolicyRegistry();
policies.register(amountLimit);
policies.seal();

/* In the endpoint, once the record is loaded and before it is written. */
const decision = authorizeRecord(
	policies,
	principal,
	'expenses.claims.approve',
	claim,
	'approve',
);
if (!decision.allowed) {
	throw new HttpProblem('POLICY_DENIED', decision.reason, 403);
}
```

`authorizeRecord` checks the permission scope first and evaluates policies only
after it holds, so a policy never sees a principal that lacks the permission. It
answers the first denial in registration order; a permission with no policy is
allowed by the scope alone. A policy that throws denies rather than escaping
into the endpoint. Register once per id, at most 256 policies, and seal the
registry before serving requests: a policy registered at request time would
change a decision under the requests already in flight.

`requiresApproval.requirement` carries `roleKey`, `scope`, `decisions` and
`expiresInDays`, and nothing else. Resolving a role to people, collecting their
decisions and keeping the receipt belong to the module that owns approvals; the
kernel owns the shape so a denial can name what would lift it. The platform does
not compose a shared registry yet, so a module that wants record conditions today
owns its registry inside its own composition.

## List pagination

New list endpoints page with the helpers in `@flowdular/server`
(`packages/server/src/pagination.ts`). The endpoints written before them keep
their own paging until the owning module retrofits it in its own change, so do
not migrate another module's list while touching yours.

```ts
const page = readPageQuery(new URL(octane.request.url), { maxLimit: 100 });
const after = page.cursor ? decodeCursor(page.cursor, cursorSecret) : null;
const keyset = after
	? keysetWhere(
			['created_at', 'id'],
			[Number(after['createdAt']), String(after['id'])],
			{ parameterOffset: 1 },
		)
	: null;

/* One row more than the page is what says whether another page exists. */
const rows = await repository.pageClaims(tenantId, keyset, page.limit + 1);
const items = rows.slice(0, page.limit);
const last = items[items.length - 1];
return pageResponse({
	items,
	limit: page.limit,
	nextCursor:
		rows.length > page.limit && last
			? encodeCursor({ createdAt: last.createdAt, id: last.id }, cursorSecret)
			: null,
});
```

`readPageQuery` answers `{ limit, cursor }`, defaults to 50 rows, and refuses
bad input the way the rest of the input boundary does: 400 `INVALID_INPUT` for a
limit outside 1 to the endpoint's `maxLimit`, 400 `CURSOR_INVALID` for a cursor
that is too long or not cursor-shaped. The platform ceiling is 200 rows; an
endpoint narrows it with `maxLimit` and picks its own `defaultLimit`.

A cursor is the keyset of the last row of the page, HMAC signed with a 32 byte
secret the module owns and bounded to 1 KB, so a caller cannot move the page
boundary onto a row the query excludes. `decodeCursor` answers the same
`CURSOR_INVALID` for a forged, edited or retired cursor, which a client treats
as "start from the first page". Put nothing in a cursor but the ordering keys:
it is a position, not saved state.

The response body is `{ items, page: { nextCursor, limit, total? } }`.
`nextCursor` is null on the last page, and `total` belongs in the body only
where the count is cheap, which a count over a tenant's rows usually is not.
`keysetWhere(columns, cursorValues, { direction, parameterOffset })` builds
`(created_at < $2 OR (created_at = $2 AND id < $3))` with the values bound and
the column names checked as plain identifiers; the statement's `ORDER BY` must
match the columns and direction, ending in a unique column, and the table needs
an index on them. Offset paging is not a platform capability: `OFFSET` over a
tenant's rows gets slower with every page and drops rows that move.
Record history keeps its own narrower request contract, `parseHistoryRequest`
from `@flowdular/kernel`.

## Search providers

A module that owns searchable records registers a provider with `search.core`
instead of feeding a central index. Declare `search.core` under `dependencies`
so it composes first, add `{ id: "search.providers.v1", optional: true }` under
`requires`, and register in `createServerComposition`:

```ts
context.capabilities
	.get<SearchProviderRegistry>(SEARCH_PROVIDERS_CAPABILITY)
	?.register('users.core', [createMemberSearchProvider(context.auth)]);
```

A provider is `{ key, label, permission, search(input) }`. `search` receives
`{ tenantId, principal, query, limit, cursor?, signal? }` and answers
`{ hits, nextCursor }`, where a hit carries only `ref`, `title`, `snippet`,
`viewId`, `route` and `score`: search.core never opens the provider's tables and
never fetches the record. The `route` is workspace-relative and starts with `/`;
`score` orders hits inside one provider and is never compared across providers.
The query is normalized and bounded to 200 characters before a provider sees it,
and a query under two characters reaches nobody.

`search.core` runs every provider whose `permission` the principal holds in
parallel under `providerTimeoutMs`, merges provider-major, and pages the merged
stream with the platform cursor helpers. A provider that fails, times out, or
answers something unreadable contributes nothing and is named in the response's
`unavailable`; it never turns the member's search into an error. The registry is
sealed when search.core starts, so registration happens at composition and never
at request time. The capability stays optional: resolve it with `get`, register
behind `?.`, and the module still composes where search.core is not enabled.

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
