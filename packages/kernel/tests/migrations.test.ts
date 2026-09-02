import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	MIGRATION_LEDGER_TABLE,
	MigrationError,
	moduleMigrationChecksum,
	moduleMigrationStatus,
	runModuleMigrations,
	type MigrationDatabase,
	type ModuleMigration,
} from '../src/index.ts';

function database(): DatabaseSync {
	return new DatabaseSync(':memory:');
}

function ledgerIds(db: MigrationDatabase): readonly string[] {
	return (
		db
			.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
			.all() as readonly { id: string }[]
	).map((row) => row.id);
}

function states(
	db: MigrationDatabase,
	migrations: readonly ModuleMigration[],
): readonly string[] {
	return moduleMigrationStatus(db, migrations).map((entry) => entry.state);
}

const CREATE_NOTES: ModuleMigration = {
	id: '0001_notes',
	statements: `CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS notes_body_idx ON notes (body, id);
INSERT OR IGNORE INTO notes (id, body) VALUES ('seed', 'from the migration');
`,
};

const ADD_COLUMN: ModuleMigration = {
	id: '0002_notes_pinned',
	statements: `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`,
};

describe('runModuleMigrations', () => {
	it('applies every migration on a fresh database and records the ledger', () => {
		const db = database();
		const results = runModuleMigrations(db, [CREATE_NOTES, ADD_COLUMN]);

		expect(results.map((result) => result.action)).toEqual([
			'applied',
			'applied',
		]);
		expect(ledgerIds(db)).toEqual(['0001_notes', '0002_notes_pinned']);
		expect(
			db.prepare('SELECT body, pinned FROM notes WHERE id = ?').get('seed'),
		).toEqual({ body: 'from the migration', pinned: 0 });
		expect(states(db, [CREATE_NOTES, ADD_COLUMN])).toEqual([
			'applied',
			'applied',
		]);
	});

	it('adopts an existing schema instead of re-running its statements', () => {
		const db = database();
		db.exec(`CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX notes_body_idx ON notes (body, id);
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
INSERT INTO notes (id, body) VALUES ('real', 'owner row');`);

		expect(states(db, [CREATE_NOTES, ADD_COLUMN])).toEqual([
			'adopted',
			'adopted',
		]);
		const results = runModuleMigrations(db, [CREATE_NOTES, ADD_COLUMN]);

		expect(results.map((result) => result.action)).toEqual([
			'adopted',
			'adopted',
		]);
		expect(ledgerIds(db)).toEqual(['0001_notes', '0002_notes_pinned']);
		expect(db.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([
			{ id: 'real' },
		]);
		expect(states(db, [CREATE_NOTES, ADD_COLUMN])).toEqual([
			'applied',
			'applied',
		]);
	});

	it('reports and refuses a migration edited after it was applied', () => {
		const db = database();
		runModuleMigrations(db, [CREATE_NOTES]);
		const edited: ModuleMigration = {
			id: CREATE_NOTES.id,
			statements: `${CREATE_NOTES.statements}CREATE INDEX IF NOT EXISTS notes_id_idx ON notes (id);\n`,
		};

		const [entry] = moduleMigrationStatus(db, [edited]);
		expect(entry?.state).toBe('mismatch');
		expect(entry?.reason).toContain(moduleMigrationChecksum(edited.statements));
		expect(() => runModuleMigrations(db, [edited])).toThrowError(
			MigrationError,
		);
		try {
			runModuleMigrations(db, [edited]);
		} catch (error) {
			expect((error as MigrationError).code).toBe('CHECKSUM_MISMATCH');
			expect((error as MigrationError).migrationId).toBe('0001_notes');
		}
	});

	it('stops before any write when a later migration mismatches', () => {
		const db = database();
		runModuleMigrations(db, [CREATE_NOTES]);
		const edited: ModuleMigration = {
			id: CREATE_NOTES.id,
			statements: 'CREATE TABLE IF NOT EXISTS other (id TEXT PRIMARY KEY);\n',
		};

		expect(() => runModuleMigrations(db, [edited, ADD_COLUMN])).toThrowError(
			MigrationError,
		);
		expect(ledgerIds(db)).toEqual(['0001_notes']);
		expect(
			db
				.prepare('SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?')
				.get('notes', 'pinned'),
		).toBeUndefined();
	});

	it('rolls back a failing migration and leaves no ledger row', () => {
		const db = database();
		const broken: ModuleMigration = {
			id: '0002_broken',
			statements: `CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY) STRICT;
INSERT INTO missing_table (id) VALUES ('x');
`,
		};

		expect(() => runModuleMigrations(db, [CREATE_NOTES, broken])).toThrowError(
			/0002_broken/,
		);
		expect(ledgerIds(db)).toEqual(['0001_notes']);
		expect(
			db
				.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?')
				.get('drafts'),
		).toBeUndefined();
		expect(
			db.prepare('SELECT body FROM notes WHERE id = ?').get('seed'),
		).toEqual({ body: 'from the migration' });
	});

	it('is a no-op when every migration is already in the ledger', () => {
		const db = database();
		runModuleMigrations(db, [CREATE_NOTES, ADD_COLUMN]);
		db.exec("INSERT INTO notes (id, body) VALUES ('later', 'after boot')");

		const results = runModuleMigrations(db, [CREATE_NOTES, ADD_COLUMN]);

		expect(results.map((result) => result.action)).toEqual([
			'unchanged',
			'unchanged',
		]);
		expect(db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({
			n: 2,
		});
	});

	it('refuses a migration whose objects are only half present', () => {
		const db = database();
		db.exec(
			'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;',
		);

		const [entry] = moduleMigrationStatus(db, [CREATE_NOTES]);
		expect(entry?.state).toBe('pending');
		expect(entry?.reason).toContain('index notes_body_idx');
		try {
			runModuleMigrations(db, [CREATE_NOTES]);
			expect.unreachable('half present schema must not be applied');
		} catch (error) {
			expect((error as MigrationError).code).toBe('PARTIAL_OBJECTS');
		}
		expect(ledgerIds(db)).toEqual([]);
	});

	it('lets a module reject an incompatible pre-ledger object fingerprint', () => {
		const db = database();
		db.exec(
			'CREATE TABLE notes (id TEXT PRIMARY KEY, body INTEGER NOT NULL) STRICT;',
		);
		const guarded: ModuleMigration = {
			...CREATE_NOTES,
			validateExisting: (database) => {
				const row = database
					.prepare(
						"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
					)
					.get() as { sql: string } | undefined;
				if (row && row.sql.includes('body INTEGER')) {
					throw new MigrationError(
						'PARTIAL_OBJECTS',
						CREATE_NOTES.id,
						'The existing notes table has an incompatible fingerprint.',
					);
				}
			},
		};

		expect(() => moduleMigrationStatus(db, [guarded])).toThrowError(
			/incompatible fingerprint/,
		);
		expect(() => runModuleMigrations(db, [guarded])).toThrowError(
			/incompatible fingerprint/,
		);
		expect(ledgerIds(db)).toEqual([]);
	});

	it('lets a module decide adoption for a migration that only moves rows', () => {
		const backfill: ModuleMigration = {
			id: '0003_backfill',
			statements: "UPDATE notes SET body = 'backfilled' WHERE body = '';\n",
			adoptWhen: (db) =>
				db.prepare("SELECT 1 AS present FROM notes WHERE body = ''").get() ===
				undefined,
		};
		const applied = database();
		runModuleMigrations(applied, [CREATE_NOTES]);
		applied.exec("INSERT INTO notes (id, body) VALUES ('blank', '')");

		expect(states(applied, [CREATE_NOTES, backfill])).toEqual([
			'applied',
			'pending',
		]);
		runModuleMigrations(applied, [CREATE_NOTES, backfill]);
		expect(
			applied.prepare('SELECT body FROM notes WHERE id = ?').get('blank'),
		).toEqual({ body: 'backfilled' });

		const adopted = database();
		runModuleMigrations(adopted, [CREATE_NOTES]);
		expect(states(adopted, [CREATE_NOTES, backfill])).toEqual([
			'applied',
			'adopted',
		]);
	});

	it('asks a predicate only once the earlier migrations have run', () => {
		const backfill: ModuleMigration = {
			id: '0002_notes_upper',
			statements: "UPDATE notes SET body = upper(body) WHERE id = 'seed';\n",
			/* Answerable only after 0001 created notes and inserted the seed. */
			adoptWhen: (db) =>
				db.prepare("SELECT 1 AS present FROM notes WHERE id = 'seed'").get() !==
				undefined,
		};
		const db = database();

		const results = runModuleMigrations(db, [CREATE_NOTES, backfill]);

		expect(results.map((result) => result.action)).toEqual([
			'applied',
			'adopted',
		]);
		expect(
			db.prepare('SELECT body FROM notes WHERE id = ?').get('seed'),
		).toEqual({ body: 'from the migration' });
	});

	it('never adopts on a predicate that cannot answer', () => {
		const db = database();
		const guarded: ModuleMigration = {
			id: '0001_guarded',
			statements: 'CREATE TABLE IF NOT EXISTS guarded (id TEXT PRIMARY KEY);\n',
			adoptWhen: () => {
				throw new Error('no such table: absent');
			},
		};

		expect(states(db, [guarded])).toEqual(['pending']);
		expect(runModuleMigrations(db, [guarded])[0]?.action).toBe('applied');
	});

	it('yields to another writer that recorded the migration first', () => {
		const real = database();
		runModuleMigrations(real, [CREATE_NOTES]);
		let raced = false;
		/* Stands in for the running server committing the same migration between
		   this call reading the ledger and taking the write lock. */
		const racing: MigrationDatabase = {
			exec(sql) {
				if (!raced && sql === 'BEGIN IMMEDIATE') {
					raced = true;
					real.exec(ADD_COLUMN.statements);
					real
						.prepare(
							`INSERT INTO ${MIGRATION_LEDGER_TABLE} (id, checksum, applied_at) VALUES (?, ?, ?)`,
						)
						.run(
							ADD_COLUMN.id,
							moduleMigrationChecksum(ADD_COLUMN.statements),
							1,
						);
				}
				real.exec(sql);
			},
			prepare: (sql) => real.prepare(sql),
		};

		const results = runModuleMigrations(racing, [CREATE_NOTES, ADD_COLUMN]);

		expect(raced).toBe(true);
		expect(results.map((result) => result.action)).toEqual([
			'unchanged',
			'unchanged',
		]);
		expect(ledgerIds(real)).toEqual(['0001_notes', '0002_notes_pinned']);
	});

	it('writes nothing on a dry run', () => {
		const db = database();
		const results = runModuleMigrations(db, [CREATE_NOTES], { dryRun: true });

		expect(results.map((result) => result.action)).toEqual(['applied']);
		expect(
			db
				.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?')
				.get('notes'),
		).toBeUndefined();
		expect(
			db
				.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?')
				.get(MIGRATION_LEDGER_TABLE),
		).toBeUndefined();
	});

	it('rejects a list that repeats an id', () => {
		expect(() =>
			runModuleMigrations(database(), [CREATE_NOTES, CREATE_NOTES]),
		).toThrowError(/listed twice/);
	});
});

describe('moduleMigrationChecksum', () => {
	it('ignores line endings and surrounding blank space only', () => {
		const base = 'CREATE TABLE t (id TEXT);\n';
		expect(moduleMigrationChecksum(base)).toBe(
			moduleMigrationChecksum(`\r\n${base.replace('\n', '\r\n')}  `),
		);
		expect(moduleMigrationChecksum(base)).not.toBe(
			moduleMigrationChecksum('CREATE TABLE  t (id TEXT);\n'),
		);
		expect(moduleMigrationChecksum(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe('adoption detection', () => {
	it('ignores object names that appear only in comments or string literals', () => {
		const db = database();
		db.exec('CREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT) STRICT;');
		const migration: ModuleMigration = {
			id: '0001_audit_rows',
			statements: `-- CREATE TABLE audit is described here, not declared.
INSERT OR IGNORE INTO audit (id, note) VALUES ('1', 'CREATE TABLE audit (x TEXT)');
`,
		};

		expect(states(db, [migration])).toEqual(['pending']);
		runModuleMigrations(db, [migration]);
		expect(db.prepare('SELECT count(*) AS n FROM audit').get()).toEqual({
			n: 1,
		});
	});

	it('adopts a quoted and a unique-index declaration', () => {
		const db = database();
		db.exec(`CREATE TABLE "party list" (id TEXT PRIMARY KEY, slug TEXT) STRICT;
CREATE UNIQUE INDEX party_slug_idx ON "party list" (slug);`);
		const migration: ModuleMigration = {
			id: '0001_party_list',
			statements: `CREATE TABLE IF NOT EXISTS "party list" (id TEXT PRIMARY KEY, slug TEXT) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS party_slug_idx ON "party list" (slug);
`,
		};

		expect(states(db, [migration])).toEqual(['adopted']);
	});
});
