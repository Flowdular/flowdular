# Database adapters

Flowdular runs on PostgreSQL. There is one platform-owned provider and one
database behind it. Locally you get the same engine embedded in the process
through PGlite, so a workstation needs no server and no configuration, and a
deployment points the same code at a real cluster.

`@flowdular/database` is the SQL boundary every module repository builds on. It
is asynchronous because every supported PostgreSQL driver is asynchronous. A
module never sees a DSN, a pool or a driver; it acquires a lease from the
provider and gives it back.

## The single provider

`platform/src/server/database.ts` builds the provider once:

```ts
import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';
import { Pool } from 'pg';

const config = databaseProviderConfigFromEnvironment(
	process.env,
	workspaceRoot,
);
const databases = createDatabaseProvider(config, {
	postgresPool: (options) => new Pool(options),
	pgliteCluster: (options) => createPgliteCluster(options),
});
```

`@flowdular/database` owns no driver, so the caller supplies both. Composition
injects the result as `PlatformServerContext.databases`, and that is the only
way a module reaches storage. `GET /api/ready` reports the live adapter and
answers 503 while the database is unreachable.

The sandbox preview builds its own embedded provider under the session data
directory instead, so a draft never reaches a deployment database.

## Configuration

`FD_DATABASE_ADAPTER` selects the adapter. It accepts `pglite` or `postgresql`
and nothing else. Unset, it is `pglite` outside production and `postgresql`
when `NODE_ENV=production`. `FD_DATABASE_ADAPTER=pglite` in production is
refused at startup.

| Variable                           | Default                                   | Purpose                                                                      |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `FD_DATABASE_ADAPTER`              | `postgresql` in production, else `pglite` | `pglite` or `postgresql`                                                     |
| `FD_DATABASE_PGLITE_DIRECTORY`     | `.flowdular/data/pglite`                  | Data directory of the embedded database                                      |
| `FD_DATABASE_URL`                  | none                                      | Runtime role DSN; required for the `postgresql` adapter                      |
| `FD_DATABASE_MIGRATOR_URL`         | `FD_DATABASE_URL` outside production      | Schema-owning DSN; required in production                                    |
| `FD_DATABASE_BACKGROUND_URL`       | none                                      | Cross-tenant read-only DSN; without it a `background` lease is refused       |
| `FD_DATABASE_TLS`                  | `verify-full`                             | `verify-full`, `require`, or `disable`; production allows only `verify-full` |
| `FD_DATABASE_TLS_CA`               | none                                      | Certificate authority as an inline PEM value                                 |
| `FD_DATABASE_TLS_CA_FILE`          | none                                      | Certificate authority read from a mounted file                               |
| `FD_DATABASE_POOL_MIN`             | `0`                                       | Minimum pooled connections per role                                          |
| `FD_DATABASE_POOL_MAX`             | `10`                                      | Maximum pooled connections per role                                          |
| `FD_DATABASE_CONNECT_TIMEOUT_MS`   | `5000`                                    | Connection acquisition timeout                                               |
| `FD_DATABASE_IDLE_TIMEOUT_MS`      | `30000`                                   | Idle connection timeout                                                      |
| `FD_DATABASE_STATEMENT_TIMEOUT_MS` | `15000`                                   | Server-side statement timeout                                                |
| `FD_DATABASE_QUERY_TIMEOUT_MS`     | `20000`                                   | Driver query timeout; never shorter than the statement timeout               |
| `FD_DATABASE_LOCK_TIMEOUT_MS`      | `5000`                                    | Server-side lock timeout; never longer than the statement timeout            |

Every URL must use the `postgres://` or `postgresql://` scheme and may not carry
TLS parameters in its query string; TLS is configured by the `FD_DATABASE_TLS*`
values, inline or as a file, never both. Pool minimum may not exceed pool
maximum.

With the `pglite` adapter the data directory is the only setting that applies.
Under `NODE_ENV=test` the directory is ignored and the database is held in
memory.

## Three roles

The embedded adapter creates the same roles a deployment configures, so a local
run enforces the isolation a deployment enforces instead of approximating it.

| Role                  | Owns                                        | Constraints                                                                                 |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `coreloom_migrator`   | The schema. Serves the `migration` purpose. | Owns every table the migrations create.                                                     |
| `coreloom_runtime`    | Request-time reads and writes.              | No `SUPERUSER`, no `BYPASSRLS`, and every handle it lends requires a transaction tenant id. |
| `coreloom_background` | Cross-tenant polls.                         | Read-only, and no blanket table grant.                                                      |

## Leases

A module asks for a handle by namespace and purpose:

```ts
const lease = await context.databases.acquire({
	namespace: 'profile.core',
	purpose: 'runtime',
	requirements: {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	},
});
```

| Purpose      | Role                  | Used for                                            |
| ------------ | --------------------- | --------------------------------------------------- |
| `migration`  | `coreloom_migrator`   | Applying migrations and resetting a database        |
| `runtime`    | `coreloom_runtime`    | The deployed application                            |
| `preview`    | `coreloom_runtime`    | A local run and the sandbox preview                 |
| `test`       | `coreloom_runtime`    | A test suite                                        |
| `background` | `coreloom_background` | A scheduler poll or recovery that precedes a tenant |

A runtime acquires its leases lazily, one per runtime, and releases them from
composition `dispose()`. `modules/profile/src/server/runtime.ts` is the shape:
take a `migration` lease, run the migrations, release it, then hold one
tenant-scoped lease for the life of the composition.

## Contract

The package exposes five distinct roles:

- `DatabaseProvider` is owned by platform composition. It resolves secrets,
  pools, TLS, and environment configuration, then lends a `DatabaseHandle` for
  one module namespace. A module never receives a DSN.
- `DatabaseHandle` executes parameterized statements and opens transactions. It
  cannot dispose shared provider state.
- `DatabaseAdapter` is the provider-owned handle with an idempotent `dispose()`.
- `DatabaseTransaction` is pinned to one connection and expires when its
  callback returns or throws.
- `DatabaseSchemaIntrospector` answers `hasTable`, `hasColumn` and `hasIndex`,
  which is what migration adoption inspects.

SQL is explicit. PostgreSQL binds `$1`, `$2`, and so on. Values always travel in
`DatabaseStatement.parameters`; request data is never concatenated into SQL.

`executeScript()` is reserved for trusted, checked-in migration DDL. It has no
parameter channel by design.

### Lifecycle guarantees

- An adapter is ready when its constructor returns.
- A transaction callback receives one connection-bound transaction.
- Success commits. A thrown error or an aborted transaction rolls back.
- Calling the root adapter from its own transaction callback is rejected.
- A transaction retained after its callback is rejected on every operation,
  including schema inspection.
- `dispose()` is idempotent, refuses new work, waits for already accepted work,
  and then closes the database or pool.
- `AbortSignal` and `timeoutMs` are accepted by every operation. The
  `capabilities.cancellation` value states whether cancellation can stop only
  queued work (`before-start`) or an active driver query (`driver`). A
  transaction checks cancellation again before commit.

The standard `node-postgres` bridge advertises `before-start`, because the
public `node-postgres` query contract does not provide `AbortSignal`
cancellation. That is why the pool also sets server-side `statement_timeout`,
`lock_timeout`, and a driver `query_timeout`. A custom driver bridge may
advertise `driver` only when it really cancels the active query.

Driver error classes, pool scheduling, physical connection identity, and row
type parsers are deliberately unspecified. Callers may rely only on the
normalized row and affected-row results plus the documented Flowdular error
codes.

## Tenancy

Every tenant table enables and forces row-level security and carries a policy
whose `USING` and `WITH CHECK` compare `tenant_id` with the transaction-local
`coreloom.tenant_id` setting:

```sql
ALTER TABLE profile_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_records FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_records_tenant_policy ON profile_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
```

`database.transaction(body, { tenantId, access })` sets that value for the
duration of the transaction, so a query that runs outside a tenant transaction
sees nothing. Every repository operation goes through it:

```ts
async find(tenantId: string, accountId: string): Promise<Profile | null> {
	const result = await this.database.transaction(
		(transaction) =>
			transaction.query<ProfileRow>({
				text: FIND,
				parameters: [tenantId, accountId],
			}),
		{ access: 'read', tenantId },
	);
	const row = result.rows[0];
	return row ? fromRow(row) : null;
}
```

The `WHERE tenant_id = $1` in `FIND` stays as defense in depth. The database is
what enforces the boundary.

`modules/profile/src/services/database-repository.ts` is the reference
repository.

## Migrations

The ledger is `_coreloom_migrations_v2`. It carries the module namespace because
every module shares one database. Checksums cover the exact SQL, and a mismatch
is checked before any outstanding migration runs.

`src/services/migration.ts` exports the list:

```ts
import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_profile_core',
		sql: { postgresql: PROFILE_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'profile_records',
				'profile_records_tenant_policy',
				[() => database.schema.hasIndex('profile_records_tenant_account_idx')],
			),
	},
];
```

Each constant mirrors `migrations/<id>.up.sql` byte for byte, and a module test
fails on drift. The numbered `.up.sql` and `.down.sql` files are immutable
source: add a new additive migration rather than editing applied bytes.

`inspectExisting` is the module's explicit pre-ledger adoption proof. It returns
`complete`, `absent`, or `partial`, and the runner refuses `partial` rather than
guessing. `postgresTenantTableState` is the standard check: the table exists,
row-level security is enabled and forced, the named policy is present, and every
extra thunk passes.

`runDatabaseMigrations(database, namespace, databaseMigrations)` takes an
advisory lock and applies every outstanding migration with its ledger row inside
one connection-bound transaction, so a failure leaves neither.

Operator commands:

```bash
flowdular migration new <name> --module <id> --apply  # scaffold the up and down pair
flowdular migration status [--module <id>]        # ledger state
flowdular migration apply --module <id> --apply
flowdular migration verify                        # checksums, row security, file and constant parity
```

`migration new` writes exactly two files, `migrations/<NNNN>_<stem>_<name>.up.sql`
and `.down.sql`, with the tenant table, its index, forced row-level security and
a tenant policy already scaffolded. Replace the placeholder columns with the real
schema.

`migration verify` checks that every applied ledger checksum still matches, that
every tenant table a migration leaves behind has `ENABLE ROW LEVEL SECURITY`,
`FORCE ROW LEVEL SECURITY` and a tenant policy declared after the last statement
that puts the table in place, that a `coreloom_background` policy grants no more
than `FOR SELECT`, and that every `migrations/*.up.sql` file has a matching id in
`databaseMigrations` and the other way round.

## The background role

Almost everything runs on the tenant-scoped runtime handle. Two jobs cannot: the
automations scheduler has to find due work before it knows whose it is, and a
webhook is addressed by an id that carries no tenant. Those take a `background`
lease, a third role that is read-only and holds no default table grant at all.

A table it may poll says so itself, in its own migration:

```sql
CREATE POLICY <table>_background_policy ON <table>
  FOR SELECT TO coreloom_background
  USING (<the narrowest predicate that still finds the work>);
REVOKE SELECT ON <table> FROM coreloom_background;
GRANT SELECT (<only the columns the poll reads>) ON <table> TO coreloom_background;
```

A table that forgets to is invisible to that role, and every column outside the
grant stays unreadable on that connection even in a `WHERE` clause: PostgreSQL
checks column privileges there too. The row the poll returns is routing data
only, and whatever acts on it reads the record again under the tenant that row
named. A deployment configures the role with `FD_DATABASE_BACKGROUND_URL`;
without it a `background` lease is refused with `UNSUPPORTED_CAPABILITY` rather
than quietly widened to the runtime role.

## Testing

`createTestDatabaseProvider()` from `@flowdular/database-testing` gives a suite
its own PGlite by default or an isolated server PostgreSQL schema in CI. Both
enforce the runtime and background role boundaries. For an explicitly embedded,
file-backed test, use `createPgliteTestProvider({ dataDirectory })` and
`pgliteTestDirectory()` for a disposable name.

Booting an embedded PostgreSQL costs about two seconds, so a test file opens one
provider, migrates it once, and truncates the module tables between cases.
`modules/profile/tests/support/database.ts` is the reference:

```ts
const provider = createTestDatabaseProvider();
const lease = await provider.acquire({
	namespace: 'profile.core',
	purpose: 'migration',
});
try {
	await migrateProfileDatabase(lease.database);
} finally {
	await lease.release();
}
```

`pnpm verify` runs module behavior against the embedded database. The separate
PostgreSQL CI job runs the same suites with `FD_TEST_DATABASE_ADAPTER=postgresql`
and `FD_TEST_POSTGRES_URL`, `FD_TEST_POSTGRES_RUNTIME_URL`, and
`FD_TEST_POSTGRES_BACKGROUND_URL`. All three roles are required, and server
failures never fall back to PGlite. Tenant fixture operations on the migration
connection also need tenant transactions because its role has no RLS bypass.

Tenancy tests take two tenants, prove
`TENANT_CONTEXT_REQUIRED` without a transaction tenant id, prove that row-level
security stops a cross-tenant read and a cross-tenant write under the runtime
role, and cover `WITH CHECK`. Giving that role `BYPASSRLS` must make the isolation
assertions fail, which proves that they exercise the database boundary.

## Resetting a database

`resetDatabase(database, { intent: 'confirmed-destructive-reset' })` drops every
table the handle can see, including the v2 ledger, so the next start migrates
from zero. It drops with `CASCADE` inside one transaction.
`databaseResetPlan(database)` returns the same list without changing anything,
which is the dry run.

Both refuse a tenant-scoped runtime handle, because listing tables is a root
schema operation. Only a `purpose: 'migration'` lease can reset, so request-time
module code cannot reach it even by accident.

```bash
flowdular database reset                                  # plan
flowdular database reset --apply --confirm reset-database
```

One database means the reset is never scoped to a single module: `--module` is
refused rather than silently dropping another module's tables. The data is not
recoverable afterwards.
