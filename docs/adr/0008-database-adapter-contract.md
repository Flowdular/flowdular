# ADR 0008: asynchronous database adapter contract

Status: accepted; the SQLite half is superseded (2026-09)

> Superseded in part (2026-09): the contract, the leased provider and the v2
> ledger stand, but SQLite is no longer an adapter and the synchronous
> compatibility path is gone. Flowdular runs on PostgreSQL everywhere, embedded
> through PGlite outside production. See `docs/database-adapters.md`.

## Decision

Flowdular uses the asynchronous, dialect-explicit contract in
`@flowdular/database` for new database adapter work. SQLite is the local adapter.
PostgreSQL is the first production adapter target through a structural driver
port owned by platform composition.

Transactions receive a callback-scoped session pinned to one connection.
Adapters own placeholder style, schema introspection, migration locking,
cancellation capability, pooling, and disposal. Modules own repository ports,
queries, and SQL for every dialect they support. The platform owns credentials
and gives modules leased handles through `DatabaseProvider`.

The existing synchronous SQLite repositories and kernel migration runner remain
supported during conversion. They are a compatibility path, not the contract
for PostgreSQL.

The package depends on `@flowdular/kernel` only for the existing checksum
algorithm, so v1 and v2 ledgers calculate identical hashes for identical SQL.
The kernel does not import `@flowdular/database`. A future
`PlatformServerContext` type may import the provider from this package at the
module composition layer without creating a package cycle.

## Consumer call sites

The immediate consumers are existing SQLite module repositories. They can move
to `SqliteDatabaseAdapter` one module at a time without changing storage. The
named next consumer is a PostgreSQL deployment, which supplies a pool bridge and
the same `DatabaseHandle` to an asynchronous repository.

Migration authors provide an explicit SQL script per supported dialect and an
optional adapter-backed adoption inspection. The runner owns the namespaced
ledger, checksums, transaction, and migration lock.

## Guarantees

- Query values are separate from SQL text.
- SQL is never translated between placeholder styles.
- A transaction uses one connection and its session cannot escape the callback.
- Migration checksum drift is checked before new SQL runs.
- Migration DDL and ledger rows commit or roll back together.
- Disposal is idempotent and drains accepted work.
- Capabilities describe cancellation, isolation, DDL, lock, and returning
  behavior without version sniffing.

## Deliberately unspecified

The contract does not standardize SQL syntax, database error codes, generated
identifier values, query planning, physical pool behavior, or row type parsing.
Repositories translate database-specific errors into domain errors at their own
boundary.

## Challenge record

The strongest argument against this addition is conversion cost. Current
services and repositories are synchronous, so the adapter does not make the
existing application PostgreSQL-ready by itself. A narrow seam still earns its
cost because the production target is already PostgreSQL and retaining a
synchronous public port would make that target impossible.

Rejected alternatives:

1. Extend the current structural `MigrationDatabase`. Its implementation relies
   on `sqlite_master`, `PRAGMA`, `STRICT`, and `BEGIN IMMEDIATE`, and every method
   is synchronous. Calling it neutral would preserve a false contract.
2. Rewrite `?` placeholders to `$1`. SQL strings contain comments, literals,
   operators, DDL types, and dialect features. Text replacement would corrupt
   valid queries while hiding the real compatibility work.
3. Put `pg` pools and DSNs in modules. That duplicates pools, exposes secrets,
   and makes teardown and production policy impossible to enforce centrally.
4. Adopt an ORM now. It would add a second query and migration system before one
   reference module proves that abstraction is needed.

## Follow-up required for production PostgreSQL

Add `pg` to the deployable platform, create the secret-backed provider, inject
it into server composition, convert a reference module to asynchronous
repositories, add PostgreSQL integration tests, and run its migrations against
an empty database plus an upgraded snapshot. Until that work lands, PostgreSQL
is an implemented adapter seam rather than the application's selected production
database.
