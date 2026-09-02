---
name: migration-authoring
description: "Add or change a module's SQLite schema the way the platform applies it: numbered SQL files are the source, a per-database ledger records what ran, checksums make applied migrations immutable, and an existing database is adopted rather than re-run."
roles:
  - backend-engineer
  - module-executor
  - reviewer
when: A module needs a new table, column, index, or constraint.
---

# Author a migration

## 1. Reality first

`migrations/NNNN_<module>_<name>.up.sql` is the source of truth. `packages/kernel/src/migrations.ts` runs it and records it. What happens:

- `src/services/migration.ts` exports `migrations: readonly ModuleMigration[]`, one entry per numbered file, in file order. Each `statements` constant mirrors its `.up.sql` file byte for byte, and `tests/migrations.test.ts` fails when they drift.
- `src/services/sqlite-repository.ts` calls `runModuleMigrations(this.#database, migrations)` once in its constructor, after the connection pragmas.
- The runner keeps `_coreloom_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)` in the module's own database.
- One SQLite file per database-owning module: `CL_<MODULE>_DATABASE`, else `/data/<module>.db` in production, else `.coreloom/data/<module>.db` (`src/server/runtime.ts`). Production mounts `/data` (`infra/kubernetes/data-pvc.yaml`, `infra/docker/compose.yaml`).
- `.down.sql` stays as documentation of the reverse. Nothing executes it.

Every database-owning module uses this runner: `agents`, `auth`, `automations`, `catalog`, `expenses`, `parties`, `profile`, and `sandbox`. `users.core` stores its data through `auth.core` and therefore does not own a separate database or migration list. `coreloom migration verify --json` must report no unmanaged database-owning module.

## 2. What the runner does per migration

Checked in order, on the database as it stands when that migration is reached:

| Situation                                                  | Result                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ledger has the id, checksum matches                        | nothing runs                                                                           |
| Ledger has the id, checksum differs                        | `MigrationError` `CHECKSUM_MISMATCH`, before any statement of any migration runs       |
| Not in the ledger, every object it declares already exists | **adopted**: only the ledger row is written                                            |
| Not in the ledger, none of its objects exist               | **applied**: the statements run in a transaction, then the ledger row, both or neither |
| Not in the ledger, some objects exist                      | `MigrationError` `PARTIAL_OBJECTS`, nothing runs                                       |

Adoption is what lets a database that predates the ledger keep its rows. The runner reads the objects out of the SQL itself (`CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `CREATE VIEW`, `CREATE TRIGGER` against `sqlite_master`; `ALTER TABLE t ADD COLUMN c` against `pragma_table_info`), ignoring names inside comments and string literals.

The checksum is `sha256:<hex>` of the statements with CRLF normalized to LF and the whole text trimmed. Every other byte counts, whitespace included.

A migration that only moves rows declares no objects, so it cannot be adopted by inspection. Give it an `adoptWhen(database)` predicate that answers "the effect this migration carries is already in this database". When supplied it is the only thing consulted, so it must also cover any DDL in the same file. A predicate that throws is never an adoption. `modules/auth/src/services/migration.ts` shows the pattern for scope backfills.

## 3. Rules for the SQL

- `CREATE TABLE IF NOT EXISTS ... STRICT;` with explicit types: `TEXT`, `INTEGER`, `REAL`, `BLOB`.
- `id TEXT PRIMARY KEY` filled with `randomUUID()` by the service; `tenant_id TEXT NOT NULL` on every tenant-owned table; `created_at INTEGER NOT NULL` (milliseconds from `Date.now()`).
- Enums and ranges as `CHECK` (`kind IN ('product', 'service')`, `base_price_minor >= 0`).
- Uniqueness inside a tenant: `UNIQUE (tenant_id, <normalized key>)`; store the normalized form in its own column (`sku_normalized`) and keep the display form.
- Indexes start with `tenant_id` and end with `id` for a stable order: `CREATE INDEX IF NOT EXISTS <table>_tenant_<col>_idx ON <table> (tenant_id, <col>, id);`.
- Money as integer minor units plus a currency code column; never `REAL`.
- Cross-module foreign keys do not exist; reference another module's record by id only and read it through that module's service.
- Additive only. `IF NOT EXISTS` still belongs on every `CREATE`: it is what makes a half-adopted database report `PARTIAL_OBJECTS` instead of failing on a name clash.
- Connection pragmas (`foreign_keys`, `journal_mode`) belong in the repository constructor. `PRAGMA` inside a migration is a no-op, because the statements run inside a transaction.

## 4. Adding a migration

Write the SQL file first, then mirror it.

`migrations/0003_parties_contacts.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS party_contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('billing', 'delivery', 'general')),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, party_id, email)
) STRICT;
CREATE INDEX IF NOT EXISTS party_contacts_tenant_party_idx
  ON party_contacts (tenant_id, party_id, id);
```

`migrations/0003_parties_contacts.down.sql` holds the reverse (`DROP INDEX IF EXISTS ...;` then `DROP TABLE IF EXISTS ...;`).

`src/services/migration.ts`, appended; existing constants stay byte for byte:

```ts
export const PARTIES_MIGRATION_003 = `CREATE TABLE IF NOT EXISTS party_contacts (
  id TEXT PRIMARY KEY,
  ...
) STRICT;
CREATE INDEX IF NOT EXISTS party_contacts_tenant_party_idx
  ON party_contacts (tenant_id, party_id, id);
`;

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_parties_core', statements: PARTIES_MIGRATION_001 },
	{
		id: '0002_parties_vat_id',
		statements: PARTIES_MIGRATION_002_VAT_ID_COLUMN,
	},
	{ id: '0003_parties_contacts', statements: PARTIES_MIGRATION_003 },
];
```

The template literal opens directly on the first SQL character and closes after the file's trailing newline. The `id` is the file name without `.up.sql`. Nothing changes in the repository constructor.

A new column no longer needs a guard: `ALTER TABLE parties ADD COLUMN vat_id TEXT;` in its own numbered file runs once on a database that lacks the column and is adopted on one that has it. Keep the `ADD COLUMN` and its backfill in the same file; they are one unit of work.

Then extend the row interface, `fromRow`, `INSERT` and `SELECT` lists, the domain type, service validation, endpoint parsing and the client.

## 5. Verify the runner integration

Every database-owning module has the same integration shape:

1. Every constant has a numbered `.up.sql` file, and the exported `migrations` list covers every file in order.
2. The repository constructor calls `runModuleMigrations(this.#database, migrations)` once after connection pragmas and before seeds or normal queries.
3. `@coreloom/kernel` is a declared dependency.
4. `tests/migrations.test.ts` covers the four cases below.
5. `pnpm coreloom migration status --module <id> --json` against a copy of an existing database reports every pre-ledger migration as `adopted`, never `pending`.

Seeding that is not a migration, such as auth's built-in roles for each tenant, stays after the runner call.

## 6. Tests and gates

Every converted module carries `tests/migrations.test.ts` with four cases:

- the constants equal their `.up.sql` files, and the ids cover every file in `migrations/`;
- a fresh database reaches `applied` for every migration;
- a database that already carries the schema and rows reaches `adopted`, keeps its rows, and ends with a full ledger;
- a second repository construction runs clean.

Plus tenant isolation and uniqueness tests for every new constraint.

Commands:

```
pnpm coreloom migration status [--module <id>] [--json]   read-only, no approval
pnpm coreloom migration apply --module <id> [--apply]     dry run without --apply, development or test only
pnpm coreloom migration verify                            every ledger row against the workspace checksums
```

`migration apply` without `--apply` opens the database read-only, so it cannot even create the file. `pnpm coreloom migration status` reporting `pending` on a populated database means the runner is about to write; read the plan before you pass `--apply`.

Gates: `typecheck`, `tests`, `format`, and `pnpm coreloom migration verify`. Sandbox eject or a PR then lands the change; production applies it on the next boot of the server.

## 7. What to refuse

- Editing an already applied migration, including its `CREATE TABLE` body. The checksum blocks startup for everyone who applied the old text. Add a new numbered file instead.
- Destructive changes (`DROP TABLE`, `DROP COLUMN`, type changes, tightening a `CHECK` on existing data) without an operator decision and a backup plan; `.down.sql` is documentation, nothing runs it.
- Renumbering, reordering, or removing a migration that shipped.
- A table without `tenant_id` unless the spec says tenancy is `none`.
- Writing to another module's database file.
- Forcing past a `PARTIAL_OBJECTS` error. It means the database is in a state no migration produced; find out why first.

## Pitfalls

- `PRAGMA journal_mode = WAL` leaves `-wal` and `-shm` files next to the database; `.coreloom/` is git-ignored.
- `STRICT` rejects a JavaScript `number` with a fraction for an `INTEGER` column at insert time; validate with `Number.isSafeInteger`.
- `String(error).includes('<table>.tenant_id')` is how services detect a unique violation; renaming the table or constraint columns breaks that mapping.
- Reformatting an applied `.up.sql` file, even only its indentation, changes the checksum and blocks every database that applied it.
- `AUTH_MIGRATION_002` to `013` in `modules/auth` insert other modules' scopes into auth tables; a new bundled module that wants default member scopes needs a new numbered file there, which is a core change.
- The ledger lives in each module's own database, so a module's history is only as portable as its file. Copying a database without its `_coreloom_migrations` table makes the next boot adopt everything again, which is safe but loses the applied timestamps.
