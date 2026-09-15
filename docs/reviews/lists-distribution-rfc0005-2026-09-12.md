# RFC 0005 first wave review record (2026-09-12)

Scope: the wave the owner accepted on 2026-09-12: I1 (official modules on
the current core), I4 with the small I6 items (review follow-ups and the
open audit items), I2 (server-side lists), I3 (selection and bulk actions),
I7 (documentation) at any point. This record grows with the wave.

## I1: official modules against the current core

Delivered in `Flowdular/official-modules` pull request #1 (branch
`feat/core-0.2-compat`, commits `d7544e8` and `b8281b3`), tested against the
SDK packed from this tree at `flowdular` 0.2.4, `@flowdular/sdk` 0.2.4,
`create-flowdular` 0.2.6.

| Module        | Version | Spec hash (sha256, first 16) |
| ------------- | ------- | ---------------------------- |
| catalog.core  | 0.7.0   | `ec931c78f351c7fc`           |
| expenses.core | 0.7.0   | `5d212d7c59e75e41`           |
| parties.core  | 0.9.0   | `7fb80fd6d926c167`           |

- Ranges: `system.core ^0.7.0`, `auth.core ^0.13.0`, `platformApi ^0.1.0`
  in module.json and spec; the kernel refused the previous exact pins.
- Data classes: items, claims and parties with their history are exported
  per tenant in bounded keyset pages inside the module's own transaction; no
  class is swept or erased; the idempotency ledgers of catalog and parties are
  excluded from the export with a stated reason because the approved specs
  call them durable replay evidence. Spec bullets added under `invariants`
  and `dataOwnership` under the owner's blanket approval; schemaVersion 1 is
  still accepted by the validator.
- Review records carry the new source digests; `release:pack --local`
  produced the three release artifacts and the local index.
- Gates in the official repository against the packed SDK: rules, typecheck,
  tests (expenses 54, catalog 35, parties 68, consumer 3), `module validate`,
  prettier.
- Acceptance in a fresh consumer app created by the SDK smoke (21 core
  modules): `module install` of the three releases from the local index,
  `module enable`, `module validate`, the app's `verify` (168 official module
  tests) and `build`, all exit 0.
- In this tree: `.ai/references/catalog` regenerated from the 0.7.0 artifact
  by `scripts/module-reference.mjs` (provenance pinned to `b8281b3`),
  `docs/module-distribution.md` names platform API 0.1.3.

Open: the official lockfile still resolves the 0.1.0 SDK, so its CI stays
red on `--frozen-lockfile` until the 0.2.4 packages are on npm and the
lockfile is regenerated; the owner deferred that publication. The first
commit's hunk split put a few data class spec bullets next to the version
changes; the content is right, the split is not clean.

One lesson repeated: a YAML scalar in a spec bullet with `: ` inside parses
as a mapping and fails the schema; three agents wrote such bullets and the
packer refused the release until they were rephrased.

## I4, the small I6 items and I7

Delivered on the branch `feat/rfc0005-wave-1` from the tip of PR #1, as six
implementation streams with disjoint file ownership, five read-only
reviewers, and one fix round.

### Modules and specs after the wave

| Module             | Version | Spec hash (sha256, first 16) |
| ------------------ | ------- | ---------------------------- |
| agents.core        | 0.12.7  | `ededcf30f1a8fb65`           |
| approvals.core     | 0.1.11  | `a2797df05a5b720b`           |
| audit.core         | 0.2.8   | `50eb919903883b0d`           |
| auth.core          | 0.13.8  | `82d3a94dada36ab1`           |
| automations.core   | 0.6.5   | `5472af2098e21f8a`           |
| connectors.core    | 0.1.4   | `91ed663a1de1aa30`           |
| directory.core     | 0.1.7   | `97e2b794537c0f06`           |
| exports.core       | 0.2.2   | `b3d5e511f4be3c46`           |
| import.core        | 0.1.8   | `f1bfc26390eab170`           |
| metering.core      | 0.1.7   | `ccd7feab441e78a7`           |
| notifications.core | 0.2.6   | `387766da0255301e`           |
| profile.core       | 1.5.2   | `47ee226e825a1e45`           |
| sandbox.core       | 0.4.1   | `e642d1d46fd22de6`           |
| search.core        | 0.1.5   | `23bb292f29293a09`           |
| workflows.core     | 0.6.6   | `27c2cbaa2a0ecd07`           |

Platform API 0.1.4 (`jobBackoff`, `integer`, `trapFocus`,
`focusableElements`). Only the auth spec changed in content (the mail locale
rule and the actor kinds); every other bump is a patch for a source change
under the same spec.

### What landed

- I4a: `jobBackoff(intervalMs)` in `@flowdular/server` replaces the eight
  copies of the backoff literal.
- I4b: auth mail wording comes from the translations bundle of the
  workspace's `defaultLocale` setting (`en` fallback, `pl` written), the
  spec outOfScope narrowed to per-workspace custom phrasing.
- I4c: `trapFocus` and `focusableElements` exported from `@flowdular/ui` and
  adopted by the command palette, which restores the opener on close. The
  palette's results list had never rendered in a browser: its keyed loop
  iterated an `entries()` iterator the runtime cannot index; it renders now.
- I4d: the exports catalogue answers from the sealed list registry without a
  database lease.
- I6 #7: audit write failures in auth count on `audit_write_failures_total`
  and reach the error sink without driver detail; the platform and template
  compositions pass `createModuleMetrics('auth.core')`.
- I6 #8: auth 0032 admits the `service` actor kind with a
  `configured_by_json` column; operators and identity providers are recorded
  as service actors.
- I6 #10: automations 0003 and 0004 adoption probes check the index, the
  background policy row and the column grant, and report partial adoption.
- I6 #14: the agents preflight reads the module agent catalogue on a runtime
  lease under the sentinel tenant, never a migration lease.
- I6 #15: `setup migrate-state` copies the key files only and warns per
  SQLite database file it leaves in place.
- I6 #19: workflows has a request harness and an authenticated 2xx test per
  write route plus a CSRF mismatch refusal.
- I6 #20: the sandbox directory reads member scopes in one auth call.
- I6 #22: one `integer(value, field, { min? })` decoder in
  `@flowdular/database` replaces the seventeen repository copies and the two
  template copies, each site keeping its strictness.
- The agents worker classifies an event write refused on a run it no longer
  holds as a lost lease (the CI race), classifies once and drains before
  release.
- I7: blueprint section 14 describes the agent layer that shipped;
  `docs/sandbox.md` documents the `git-pr` delivery target; the policy files
  and `.ai/README.md` name what reads them.

### Review findings

- Jobs and decoder: 3 low (template copies, the API bump covering more than
  two additions, the agents decoder tightening). Fixed or recorded.
- Auth: 2 medium (no composition passed `metrics` to the auth runtime, no
  runtime-level locale test), 2 low (configuredBy and settings audit paths
  untested). Fixed.
- UI, exports, sandbox: 1 low (jsdom devDependency). Fixed.
- Automations, workflows, agents, CLI: 1 high (an untracked harness file,
  staged), 1 medium (the asynchronous classification could lose the race
  with the run's own failure path), 3 low. Fixed; the `.db` warning now
  covers any database file.
- Documentation: 1 high, 1 medium, 3 low on claims the code did not back
  (`requireReviewer` location, the compare link, the dependency budget).
  Fixed.

### Gates

Final run on 2026-09-12 after the fix round:

- Typecheck, `migration verify`, `capabilities:check` (49 UI exports),
  `platform-api:check` (0.1.4), `reference:check`: exit 0.
- `pnpm verify`: exit 0, 431 test files, 3694 tests passed, 3 skipped (the
  hosted PostgreSQL suite without a server).
- The CI adapter matrix (database-testing, auth, agents, profile, sandbox,
  automations, workflows) on a local PostgreSQL 17 with the CI roles: all
  green; the agents recovery suite four times in a row.
- `pnpm build`, `pnpm release:pack`: exit 0.
- `pnpm release:smoke` with `claude` and `codex` hidden from `PATH`: exit 0,
  the consumer's regenerated composition byte-identical to the template.

### Follow-ups

- `module version bump` does not rewrite a quoted `specVersion` scalar
  (profile); aligned by hand.
- The scaffold still emits a private `whole()` decoder for integer fields.
- The audit items #11, #12, #13 and #18 stay open as RFC 0005 recorded.

## I2 and I3 (delivered 2026-09-13)

Branch `feat/rfc0005-wave-2` from the tip of PR #2: eight I2 streams with
disjoint module ownership (users with auth, approvals, agents, workflows,
automations, notifications, connectors, directory), the `Table` selection
model in `packages/ui`, then four bulk action consumers (documents, users,
approvals, notifications). Four streams were cut off by an API limit and
resumed from their transcripts with their edits intact. Five reviewers
covered I2 and the selection model, one more the four bulk endpoints; one
fix round each.

### Modules and specs after the wave

| Module             | Version | Spec hash (sha256, first 16) |
| ------------------ | ------- | ---------------------------- |
| agents.core        | 0.12.8  | `1c204b23f12271b3`           |
| approvals.core     | 0.1.12  | `81a4b6d371d86356`           |
| auth.core          | 0.13.9  | `b436849ebdd6e8d0`           |
| automations.core   | 0.6.6   | `5741212e392fbf71`           |
| connectors.core    | 0.1.5   | `667c166a616a0567`           |
| directory.core     | 0.1.8   | `95984966013f6791`           |
| documents.core     | 0.1.7   | `16bf31f344d2cb10`           |
| notifications.core | 0.2.7   | `fd0981ed237c19be`           |
| users.core         | 0.9.7   | `3b91aa3579321d2b`           |
| workflows.core     | 0.6.7   | `2284df5c4926c9fe`           |

Platform API 0.1.5 (`TableSelection`, `TableBulkAction`). Every spec change
is under the owner's blanket approval: a paging sentence per list, the new
context reads, the bulk actions and their scenarios.

### What landed

- One contract for every list: `limit` (50 default, 200 max unless the
  module bounds lower), `cursor`, `sort`, `direction` and the list's filters
  as query parameters; the platform's signed cursor (`encodeCursor`) bound to
  the tenant, the sort, the direction and a digest of the filters, refused
  with `CURSOR_INVALID` on any mismatch; `pageResponse` with a cursor only on
  a full page; one keyset read per list over `(sort column, id)` in one
  direction; `Table mode="server"` with a cursor stack in the module's client
  state, a load sequence so a late response never overwrites a newer one,
  and filters pushed into SQL. No client-side sort or filter over a whole set
  remains on the seventeen lists.
- Index migrations where the order needed them: auth 0033 (display name
  and e-mail keysets on accounts), approvals 0004, agents 0025, automations
  0006, notifications 0013, workflows 0009; connectors and directory page on
  existing indexes. Plan tests in auth, approvals and agents assert the
  keyset index and no Sort node.
- Fan-outs split into context reads: `users.members.context`,
  `agents.definitions.context`, `automations.options` and
  `automations.triggers.options`, `directory.groups.context`; agents gained
  `agents.runs.get`; workflows dropped its module-local cursor codec for the
  shared cursor (the module key and its previous key still sign and verify,
  the SSE resume id included).
- `Table` selection: a controlled `selection` (keys, labels, `selectable`),
  a header checkbox over the visible page only, a live region, and a
  `bulkActions` bar with the reason pattern and a clear button.
- Bulk actions, each a sibling route with the single-row permission and
  CSRF, a bounded unique id list, per-id outcomes and the existing service
  path per row: documents delete-many, users status-many and role-many (the
  acting principal and the last owner refused per id), approvals
  decide-many (eligibility re-checked per request, the callback per decided
  request), notifications inbox transition-many (scoped to the recipient).

### Review findings

- users, auth, approvals: 2 medium (approvals order matched no index; a
  long search term could push the users cursor past its length bound), 6
  low. Fixed, apart from the approvals sortable header: the spec validator
  refuses an owned column (`createdAt`) as a screen column, recorded as a
  CLI follow-up.
- agents, workflows: 1 medium (a cursor of another agents list reached the
  audit SQL as NaN), 5 low. Fixed.
- automations, notifications: 1 medium (a client file imported a services
  module), 6 low. Fixed.
- connectors, directory: 2 medium (late responses overwriting newer ones on
  four screens; instance names resolved from the first 200 instances), 3
  low. Fixed.
- Table selection: 1 high (a custom summary function rendered instead of
  called; prettier had stripped the call parentheses), 3 low. Fixed.
- Bulk endpoints: 2 medium (the inbox mark-read had no status guard, so a
  bulk call could un-archive rows; the users last-owner refusal was
  unproven in the bulk tests), 4 low. Fixed; documents keeps its deleted
  row as the only trail, as the single delete always did.

### Gates

Final run on 2026-09-13 after the fix rounds:

- Typecheck, `spec validate`, `module validate`, `capabilities:check` (49
  UI exports), `platform-api:check` (0.1.5), `format:check`,
  `rules:check`, `migration verify`: exit 0.
- `pnpm verify`: exit 0, 444 test files, 3845 tests passed, 3 skipped (the
  hosted PostgreSQL suite without a server).
- PostgreSQL 17 with the CI roles, the CI matrix plus every paged module:
  database-testing 7, auth 333, agents 215, profile 31, sandbox 29,
  automations 108, workflows 164, approvals 88, notifications 205, users
  71, connectors 135, directory 106, documents 79 tests, all green.
- `pnpm build`, `pnpm release:pack`: exit 0.
- `pnpm release:smoke` with `claude` and `codex` hidden from `PATH`: exit 0,
  the consumer's regenerated composition byte-identical to the template.
- The CI workflow's verify and container jobs get a 30 minute limit: the
  container job on main was cancelled at 15 minutes once the suite grew.

### Follow-ups, closed on 2026-09-13

Branch `feat/rfc0005-followups`, after PR #3 merged:

- The spec validator accepts the owned column `createdAt` as a screen column
  or filter without an entity field (an entity field of that name stays
  refused, an unknown column stays refused); the approvals inbox names its
  `createdAt` sort column. `updatedAt` is not an owned column of the
  scaffolded tables and stays out.
- The users spec is schemaVersion 2 (entities, screens, actions including
  the two bulk actions, widgets, outOfScope, decisions) with every
  requirement carried over byte for byte; `createdAt` is recorded as not
  describable (D-USERS-JOINED-AT).
- The scaffold emits the shared `integer` decoder for integer fields; the
  private `whole()` helper is gone.
- Audit item #18: the module settings store contract is asynchronous
  (`load`, `save`, `clear` return promises); `prime(tenantId)` loads a
  tenant's snapshot once, `get` and `list` read it synchronously and fail
  loudly for an unprimed tenant, `set` awaits the store. The authenticated
  request path, the platform composition, the sandbox preview and every
  background reader (automations scheduler, approvals open and expiry,
  documents quota, directory SCIM, agents, notifications) prime first. A
  kernel test proves a slow store. Platform API 0.1.6. The agent contract,
  ADR 0003 and the capability card describe the primed read.

Modules after the follow-ups: agents 0.12.9 `b67b8f52cb506e3f`, approvals
0.1.13 `0a09e9f7c123608c`, auth 0.13.10 `5cec5ee6d7b91586`, automations
0.6.7 `ad558c5ed47b71c8`, directory 0.1.9 `1bbdebc013360dfa`, documents
0.1.8 `f7668e1e7bced8d5`, notifications 0.2.8 `862df1ff7af66ef3`, system
0.7.3 `9125c00267c002d2`, users 0.9.8 `0ec4b49724d7cf16`.

Gates for the follow-ups on 2026-09-13: typecheck, capability card, platform
API 0.1.6, format, rules, reference, `spec validate`, `module validate`,
`migration verify`: exit 0; `pnpm verify` 445 test files, 3858 tests passed,
3 skipped; PostgreSQL 17 with the CI roles over thirteen suites green
(approvals 91, automations 109, system 35 among them); `pnpm build`,
`release:pack`, `release:smoke` with the coding agent binaries hidden: exit
0, template composition unchanged.

The audit items #11, #12 and #13 were delivered on 2026-09-14 under the
owner's delegation, see `docs/reviews/audit-operations-2026-09-14.md`. Still
open by decision: the npm publication of the 0.3.0 packages (the 0.2.x
versions on npm predate these waves) and the official module lockfile
regeneration that follows it; H9, H10 and H11 of RFC 0004 on their
triggers; enabling modules from the administration UI.

## Official modules on the list contract (delivered 2026-09-15)

Decision (owner, 2026-09-14, item 5): the official modules get server lists,
list export and bulk actions. Delivered in `Flowdular/official-modules` pull
requests #4 (branch `feat/lists-export-bulk`) and #5 (public index pin).

- catalog.core 0.8.0: `GET /api/catalog/items` on a signed keyset cursor
  (sort name, sku, updatedAt; filters kind, status, q), export
  `catalog.core.items`, `archive-many` and `restore-many`; migration 0005 adds
  `updated_at` with a backfill and the name and updated indexes.
- expenses.core 0.8.0: claims list on the cursor with the approver join,
  export `expenses.core.claims`, `approve-many`, `reject-many` and
  `submit-many`; migration 0004 adds the sort indexes.
- parties.core 0.10.0: records list on the cursor, export
  `parties.core.records`, `archive-many` and `restore-many`; migration 0006
  adds `updated_at` and the list order indexes.
- Every module declares `requires: exports.lists.v1 optional`, so a deployment
  without `exports.core` still composes; screens use `Table mode="server"`
  with selection and a confirm dialog before a destructive bulk action.
- Minor bumps because the service `list` signatures changed; the consumer
  test in the official repository moved to the paged parties list.

Found by the official PostgreSQL job and fixed before merge: the `updated_at`
backfills matched no row under forced row-level security (the migrator holds
no tenant setting; PGlite runs as a superuser and hides it). Both migrations
lift the force flag around the backfill, the auth 0031 pattern, and were
verified on a PostgreSQL 17 cluster with the CI roles before the releases were
packed. The core reference catalog moved to 0.8.0 in the same step.
