---
name: migration-authoring
description: "Add or change a module's SQLite schema the way the platform actually applies it today: idempotent TypeScript constants run on repository construction, mirrored into numbered SQL files for review."
roles:
  - backend-engineer
  - module-executor
  - reviewer
when: A module needs a new table, column, index, or constraint.
---

# Author a migration

## 1. Reality first

There is no migration runner, ledger, checksum, lock or `down` execution. `docs/architecture-blueprint.md` section 10 describes a system that does not exist. What runs:

- `src/services/migration.ts` exports string constants (`CATALOG_MIGRATION_001` in `modules/catalog`).
- `src/services/sqlite-repository.ts` executes them in its constructor on every open, after `PRAGMA journal_mode = WAL;` (`modules/auth` also sets `PRAGMA foreign_keys = ON;`).
- `migrations/000N_<module>_<name>.up.sql` and `.down.sql` mirror the constants. Nothing reads them; they exist for review and for a future runner. `migrations/README.md` says they are append-only after release.
- One SQLite file per module: `OERP_<MODULE>_DATABASE`, else `/data/<module>.db` in production, else `.octane-erp/<module>.db` (`src/server/runtime.ts`). Production mounts `/data` (`infra/kubernetes/auth-pvc.yaml`, `infra/docker/compose.yaml`).

Because every constant runs on every open against a database that may already have the schema, every statement must be idempotent.

## 2. Rules for the SQL

- `CREATE TABLE IF NOT EXISTS ... STRICT;` with explicit types: `TEXT`, `INTEGER`, `REAL`, `BLOB`.
- `id TEXT PRIMARY KEY` filled with `randomUUID()` by the service; `tenant_id TEXT NOT NULL` on every tenant-owned table; `created_at INTEGER NOT NULL` (milliseconds from `Date.now()`).
- Enums and ranges as `CHECK` (`kind IN ('product', 'service')`, `base_price_minor >= 0`).
- Uniqueness inside a tenant: `UNIQUE (tenant_id, <normalized key>)`; store the normalized form in its own column (`sku_normalized`) and keep the display form.
- Indexes start with `tenant_id` and end with `id` for a stable order: `CREATE INDEX IF NOT EXISTS <table>_tenant_<col>_idx ON <table> (tenant_id, <col>, id);`.
- Money as integer minor units plus a currency code column; never `REAL`.
- Cross-module foreign keys do not exist; reference another module's record by id only and read it through that module's service.

## 3. Adding to an existing module

Append, never edit, a released constant:

```ts
export const PARTIES_MIGRATION_002 = `
CREATE INDEX IF NOT EXISTS parties_tenant_email_idx ON parties (tenant_id, email, id);
`;
```

A new column needs a guard, because `ALTER TABLE ... ADD COLUMN` is not idempotent. Pattern from `modules/auth/src/services/sqlite-repository.ts` (constructor):

```ts
const column = this.#database
	.prepare(
		"SELECT 1 AS present FROM pragma_table_info('parties') WHERE name = 'vat_id'",
	)
	.get();
if (!column) this.#database.exec(PARTIES_MIGRATION_002_VAT_ID_COLUMN);
this.#database.exec(PARTIES_MIGRATION_002_VAT_ID_BACKFILL);
```

Keep the `ADD COLUMN` and any backfill in separate constants so the backfill (an idempotent `UPDATE ... WHERE vat_id IS NULL`) can run every time. Then extend the row interface, `fromRow`, `INSERT` and `SELECT` lists, the domain type, service validation, endpoint parsing and the client.

Mirror every constant into `migrations/000N_<module>_<name>.up.sql` and write the reverse into `.down.sql` (`DROP INDEX IF EXISTS`, and for a column a comment that SQLite drops columns only with `ALTER TABLE ... DROP COLUMN` on 3.35+). Numbering is `0001`, `0002`, ... per module.

## 3b. Worked example: a new table in an existing module

```ts
// src/services/migration.ts (appended; 001 stays byte for byte)
export const PARTIES_MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS party_contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('billing', 'delivery', 'general')),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, party_id, email)
) STRICT;
CREATE INDEX IF NOT EXISTS party_contacts_tenant_party_idx ON party_contacts (tenant_id, party_id, id);
`;
```

```ts
// src/services/sqlite-repository.ts, constructor: one more exec after the existing ones
this.#database.exec(PARTIES_MIGRATION_003);
```

`migrations/0003_parties_contacts.up.sql` holds the same two statements; `0003_parties_contacts.down.sql` holds `DROP INDEX IF EXISTS party_contacts_tenant_party_idx;` and `DROP TABLE IF EXISTS party_contacts;`. `party_id` references a row of the same module, so it may carry `REFERENCES parties(id) ON DELETE CASCADE` only if the repository also sets `PRAGMA foreign_keys = ON;` as `modules/auth` does; otherwise keep it a plain `TEXT NOT NULL` and enforce existence in the service.

Idempotence test:

```ts
it('applies the schema twice without error', () => {
	const first = new SqlitePartyRepository(':memory:');
	expect(() => new SqlitePartyRepository(':memory:')).not.toThrow();
	expect(first.list('tenant-a')).toEqual([]);
});
```

Each `':memory:'` instance is a separate database, so this proves the constants run cleanly on an empty schema; to prove a guard against an existing schema, open a temporary file path twice in one test and remove it afterwards.

## 4. What to refuse

- Destructive changes (`DROP TABLE`, `DROP COLUMN`, type changes, tightening a `CHECK` on existing data) without an operator decision and a backup plan; there is no `down` execution to save you.
- Editing an already shipped constant, including its `CREATE TABLE` body: existing databases will not see the change and new ones will differ.
- A table without `tenant_id` unless the spec says tenancy is `none`.
- Writing to another module's database file.

## 5. Tests and gates

- `new SqliteXRepository(':memory:')` in `tests/module.test.ts` proves the constants run on an empty database; open the same `':memory:'` path twice in one test to prove idempotence when you add a guard.
- Tenant isolation and uniqueness tests for every new constraint.
- Local check against real data: `pnpm dev` once with the existing `.octane-erp/<module>.db`; a failure here is what production would see.
- Gates: `typecheck`, `tests`, `format`; the sandbox runs the same after your turn. Sandbox eject or a PR then lands the change; production applies it on the next boot of the server, with no plan step in between.

## Pitfalls

- `PRAGMA journal_mode = WAL` leaves `-wal` and `-shm` files next to the database; `.octane-erp/` is git-ignored.
- `STRICT` rejects a JavaScript `number` with a fraction for an `INTEGER` column at insert time; validate with `Number.isSafeInteger`.
- `String(error).includes('<table>.tenant_id')` is how services detect a unique violation; renaming the table or constraint columns breaks that mapping.
- `AUTH_MIGRATION_002` to `008` in `modules/auth` insert other modules' scopes into auth tables; a new bundled module that wants default member scopes needs a similar constant there, which is a core change.
