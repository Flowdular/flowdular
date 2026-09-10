---
name: database-adapter
description: >-
  Build a Flowdular module repository on the asynchronous @flowdular/database
  contract: PostgreSQL everywhere, embedded PGlite for local and test runs,
  provider leases, forced row-level security, migrations, and tenant isolation
  tests.
---
# Use the database adapter contract

Read `docs/database-adapters.md`, `packages/database/src/contracts.ts`, and the
converted `modules/profile` repository before editing. This skill is for coding
agents. It is unrelated to tenant-defined Procedures in `agents.core`.
For a driver adapter, first-run setup, adapter switch, or delivery matrix, also
read [references/first-run-and-matrix.md](references/first-run-and-matrix.md).

## 1. Keep three layers separate

1. The business repository port is database-agnostic. Domain types, services,
   errors, and callers never import a driver or branch on a dialect.
2. The module owns persistence for every dialect it declares: explicit queries,
   row mapping, error normalization, migrations, and contract tests.
3. Platform composition owns driver adapters and `DatabaseProvider`: paths,
   credentials, pools, TLS, timeouts, and disposal. A module never receives a
   DSN and never creates a production pool.

`DatabaseProvider.acquire({ namespace, purpose })` returns a lease. The module
uses `lease.database` and releases only that lease. `DatabaseHandle` exposes
async operations, open `adapterId` and `dialectId`, capabilities, transactions,
and schema introspection. A callback-scoped transaction expires on return.

The platform runs on PostgreSQL. A deployment points at a server; a
workstation, a preview and a test suite get the same PostgreSQL embedded in the
process through PGlite, so there is nothing to install and no second dialect to
keep in step. Modules write PostgreSQL and only PostgreSQL. The contract still
carries an open `dialectId` and capability negotiation so a future driver can
join, but never add a core exhaustive switch that must be edited for each one.

## 2. Make the whole repository chain asynchronous

Changing only the driver is not a conversion. Update every method in the chain:

1. `src/services/repository.ts` returns `Promise<T>` or `Promise<void>`.
2. The database repository awaits every `query`, `execute`, transaction, and
   migration call.
3. Services await repository methods. Preserve validation and domain error
   codes at this boundary.
4. Endpoints, agent tools, capabilities, background jobs, and tests await the
   service.
5. Remove synchronous assumptions such as returning a write input before the
   database confirms it.

Search every caller of the repository interface before changing it. A missed
caller can compile through an inferred promise and then serialize the wrong
value into an API response.

## 3. Acquire one provider lease per module runtime

`createServerComposition` remains synchronous. Pass `context.databases` into
the module runtime. The runtime owns one shared initialization promise that
acquires the lease and runs migrations lazily before the first repository
operation. Concurrent first requests await that same promise.

Use the module id as the namespace. Acquire `purpose: 'migration'`, run
`runDatabaseMigrations`, and release that lease before acquiring
`purpose: 'runtime'`; the application role never owns DDL. Preview uses
`purpose: 'preview'` and isolated tests use `purpose: 'test'`. A read that must
cross tenants takes `purpose: 'background'`, a read-only role with no blanket
table grant. Follow `modules/profile/src/server/runtime.ts` for the exact
sequence. `prepare()` stays read-only and never acquires a lease. `dispose()`
awaits started initialization and releases every lease once.

## 4. Write explicit SQL

Repositories own their SQL. There is no translation layer and no placeholder
rewriting.

- Parameters are `$1`, `$2`, and so on, in the order the statement binds them.
- Values always go in `DatabaseStatement.parameters`. Never concatenate request
  data, tenant ids, identifiers, sort directions, or filter values into SQL.
- Dynamic identifiers and ordering come from a closed code-owned allowlist.
- `executeScript()` is only for trusted, checked-in migration DDL. Runtime
  writes use `execute()`.
- Keep tenant predicates and tenant-first uniqueness in both dialects. Every
  tenant-owned read and write includes `tenant_id` from the trusted principal.

PostgreSQL tenant-owned tables also use database-enforced isolation:

- enable and force row-level security on the table;
- define a policy whose `USING` and `WITH CHECK` clauses compare `tenant_id`
  with `current_setting('coreloom.tenant_id', true)`;
- run application traffic under a role that is neither a superuser nor granted
  `BYPASSRLS`;
- use a separate migration role for DDL or policy ownership when required.

The adapter sets `coreloom.tenant_id` with parameterized `set_config(..., true)`
after `BEGIN` on the pinned connection. Never use an unpinned root query.
Explicit tenant predicates remain required as defense in depth.

PostgreSQL returns `BIGINT` as a string. Normalize every integer column on the
way out of a row through a local `integer()` helper. A comparison such as
`enabled === 1` silently fails without it, and a count read raw compares against
a string. Only widen timestamps and sequences to `BIGINT`; leave flags, counters
and version columns `INTEGER`.

Normalize driver-specific unique, foreign-key, serialization, and timeout
failures into the module's stable service error codes. `DatabaseError` covers
contract misuse and lifecycle errors; raw driver error classes are deliberately
not a public module contract.

## 5. Transactions and concurrency

Use the transaction argument for every operation inside a transaction callback.
Calling the root handle from that callback is rejected, and retaining the
transaction after the callback is `TRANSACTION_CONTEXT_MISUSE`.

PostgreSQL may run root operations concurrently, while a transaction is pinned
to one pooled client. Do not depend on physical connection identity or pool
order. State transitions that must be atomic belong in one transaction with an
affected-row or version check. A public repository method called from inside
another method's transaction opens a second transaction and is rejected; give it
a private in-transaction variant that takes the transaction instead.

Pass `AbortSignal` and a bounded `timeoutMs` from long-running jobs. Read
`database.capabilities` before depending on isolation or cancellation. A
`before-start` cancellation capability does not stop a driver call already in
progress. Portable tenant-owned repository methods use
`database.transaction(operation, { tenantId, access, isolation })`, including
reads. PostgreSQL root query, execute, and schema calls, and PostgreSQL
transactions without `tenantId`, fail with `TENANT_CONTEXT_REQUIRED`.

## 6. Migrations v2 and schema inspection

Use `DatabaseMigration` and `runDatabaseMigrations` from `@flowdular/database`.
Each migration has one immutable id and its PostgreSQL SQL. The ledger is
`_coreloom_migrations_v2`, keyed by module namespace and migration id; its
checksum covers that exact SQL.

`inspectExisting(database)` is the only pre-ledger adoption proof. Use
`database.schema.hasTable`, `hasColumn`, and `hasIndex` with fixed identifiers
and return:

- `complete` only when every effect of the migration exists;
- `absent` only when none exists;
- `partial` for every mixed state, which the runner refuses.

The runner acquires the adapter's migration lock and applies outstanding DDL
plus ledger rows in one serializable transaction. It refuses a missing dialect,
checksum drift, duplicate ids, partial adoption, and adapters without
transactional DDL. Never edit applied migration bytes or bypass a refusal.

`inspectExisting` must pass thunks, not eager promises. Adoption runs inside a
single-connection transaction, and overlapping queries on that connection break
it. Check in numbered `.up.sql` source and mirror its bytes in the migration
constant. A migration-only task uses `migration-authoring` in a separate phase.

## 7. Tests run on a real PostgreSQL

`createTestDatabaseProvider()` from `@flowdular/database-testing` gives a suite its
own PostgreSQL in process by default, with the same `coreloom_runtime` and
`coreloom_background` roles and the same forced row-level security a deployment
enforces. There is no server to start and no second dialect to keep green, so
the isolation assertions run on every turn rather than behind an environment
flag. CI selects server PostgreSQL with `FD_TEST_DATABASE_ADAPTER=postgresql`
and the three test role URLs; missing credentials fail instead of falling back.

Starting the engine costs roughly half a second. Open one per test file and
truncate between cases instead of paying it per test.

Cover CRUD, commit and rollback, tenant isolation and uniqueness, stable error
normalization, and concurrent version conflicts. Migration tests cover empty
apply, safe adoption, refusals, and a clean second start.

With two tenants, prove that each can see and mutate only its own rows, that a
read or write without tenant context fails with `TENANT_CONTEXT_REQUIRED`, and
that `WITH CHECK` blocks inserting another tenant id. Where a module polls
across tenants, prove that the background role reads exactly the routing columns
and is refused everything else, including writes.

## Refuse

- A DSN, password, pool, or `pg` dependency inside a module.
- A module that opens its own database file or connection.
- A closed core switch over known adapter ids.
- Root-handle work inside a transaction callback or a transaction that escapes.
- Cross-module database access. Use the owner's typed capability or API.
- A tenant table without enabled and forced row-level security, a tenant policy,
  or tests under a role that cannot bypass it.
- A cross-tenant read on the runtime role, or a background role granted whole
  rows instead of the columns its poll needs.
- Tests that mock away SQL, migration, concurrency, or tenant predicates.

## Verification

Run the module typecheck and tests, the `@flowdular/database` contract tests when
the adapter changes, `pnpm flowdular module validate --json`, and `pnpm verify`
before landing. An adapter change also needs a shutdown test proving that active
work drains before pool disposal.
