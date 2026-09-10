import { createPgliteCluster } from '@flowdular/database-pglite';
import { afterAll, describe, expect, it } from 'vitest';
import {
	DATABASE_MIGRATION_LEDGER,
	DatabaseMigrationError,
	PostgresDatabaseAdapter,
	databaseMigrationStatus,
	runDatabaseMigrations,
	type DatabaseMigration,
} from '../src/index.ts';

const CREATE_NOTES: DatabaseMigration = {
	id: '0001_notes_core',
	sql: {
		postgresql: `CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_body_idx ON notes (body, id);
`,
	},
	inspectExisting: async (database) => {
		const objects = await Promise.all([
			database.schema.hasTable('notes'),
			database.schema.hasIndex('notes_body_idx'),
		]);
		return objects.every(Boolean)
			? 'complete'
			: objects.some(Boolean)
				? 'partial'
				: 'absent';
	},
};

const ADD_PINNED: DatabaseMigration = {
	id: '0002_notes_pinned',
	sql: {
		postgresql:
			'ALTER TABLE notes ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE;\n',
	},
	inspectExisting: async (database) =>
		(await database.schema.hasColumn('notes', 'pinned'))
			? 'complete'
			: 'absent',
};

/* One embedded PostgreSQL for the file, emptied before each case, so the two
   seconds it costs to boot are paid once. */
const cluster = createPgliteCluster();
const adapter = new PostgresDatabaseAdapter({ pool: cluster.pool() });

afterAll(async () => {
	await adapter.dispose();
});

async function database(): Promise<PostgresDatabaseAdapter> {
	await adapter.executeScript(
		`DROP TABLE IF EXISTS notes, only_postgres, ${DATABASE_MIGRATION_LEDGER} CASCADE;`,
	);
	return adapter;
}

describe('adapter-aware migration runner', () => {
	it('applies, records, and then leaves migrations unchanged', async () => {
		const db = await database();
		const first = await runDatabaseMigrations(
			db,
			'notes.core',
			[CREATE_NOTES, ADD_PINNED],
			{ now: () => 42 },
		);
		const second = await runDatabaseMigrations(db, 'notes.core', [
			CREATE_NOTES,
			ADD_PINNED,
		]);

		expect(first.map((entry) => entry.action)).toEqual(['applied', 'applied']);
		expect(second.map((entry) => entry.action)).toEqual([
			'unchanged',
			'unchanged',
		]);
		/* applied_at is BIGINT. The embedded build returns it as a number while
		   the server driver returns a string, so the assertion normalizes rather
		   than pinning one of the two and passing only there. */
		const ledger = (
			await db.query<{
				namespace: string;
				dialect: string;
				applied_at: number | string;
			}>({
				text: `SELECT namespace, dialect, applied_at FROM ${DATABASE_MIGRATION_LEDGER} ORDER BY id`,
			})
		).rows.map((row) => ({ ...row, applied_at: Number(row.applied_at) }));
		expect(ledger).toEqual([
			{ namespace: 'notes.core', dialect: 'postgresql', applied_at: 42 },
			{ namespace: 'notes.core', dialect: 'postgresql', applied_at: 42 },
		]);
	});

	it('adopts a complete pre-ledger schema without replaying it', async () => {
		const db = await database();
		await db.executeScript(CREATE_NOTES.sql.postgresql!);
		await db.execute({
			text: 'INSERT INTO notes (id, body) VALUES ($1, $2)',
			parameters: ['real', 'kept'],
		});

		const result = await runDatabaseMigrations(db, 'notes.core', [
			CREATE_NOTES,
		]);

		expect(result[0]?.action).toBe('adopted');
		expect(
			(await db.query<{ body: string }>({ text: 'SELECT body FROM notes' }))
				.rows,
		).toEqual([{ body: 'kept' }]);
	});

	it('refuses partial adoption and rolls back the ledger creation', async () => {
		const db = await database();
		await db.executeScript(
			'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
		);

		await expect(
			runDatabaseMigrations(db, 'notes.core', [CREATE_NOTES]),
		).rejects.toMatchObject({ code: 'PARTIAL_MIGRATION' });
		await expect(
			runDatabaseMigrations(db, 'notes.core', [CREATE_NOTES], {
				dryRun: true,
			}),
		).rejects.toMatchObject({ code: 'PARTIAL_MIGRATION' });
		await expect(db.schema.hasTable(DATABASE_MIGRATION_LEDGER)).resolves.toBe(
			false,
		);
	});

	it('checks every recorded checksum before applying new SQL', async () => {
		const db = await database();
		await runDatabaseMigrations(db, 'notes.core', [CREATE_NOTES]);
		const edited: DatabaseMigration = {
			...CREATE_NOTES,
			sql: {
				...CREATE_NOTES.sql,
				postgresql: `${CREATE_NOTES.sql.postgresql!}\n-- edited`,
			},
		};

		await expect(
			runDatabaseMigrations(db, 'notes.core', [edited, ADD_PINNED]),
		).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
		await expect(db.schema.hasColumn('notes', 'pinned')).resolves.toBe(false);
	});

	it('plans a dry run without creating schema or a ledger', async () => {
		const db = await database();
		const result = await runDatabaseMigrations(
			db,
			'notes.core',
			[CREATE_NOTES],
			{
				dryRun: true,
			},
		);

		expect(result[0]?.action).toBe('applied');
		await expect(db.schema.hasTable('notes')).resolves.toBe(false);
		await expect(db.schema.hasTable(DATABASE_MIGRATION_LEDGER)).resolves.toBe(
			false,
		);
	});

	it('reports status without writing and scopes one ledger by namespace', async () => {
		const db = await database();
		await runDatabaseMigrations(db, 'first.core', [CREATE_NOTES]);

		expect(
			(await databaseMigrationStatus(db, 'first.core', [CREATE_NOTES]))[0]
				?.state,
		).toBe('applied');
		expect(
			(await databaseMigrationStatus(db, 'second.core', [CREATE_NOTES]))[0]
				?.state,
		).toBe('adopted');
	});

	it('refuses a migration that omits the selected dialect', async () => {
		const db = await database();
		/* A dialect map with no entry for the open dialect. A future adapter's
		   migration reaches a PostgreSQL deployment exactly this way. */
		const otherDialectOnly: DatabaseMigration = {
			id: '0001_other_dialect_only',
			sql: {},
		};

		await expect(
			runDatabaseMigrations(db, 'notes.core', [otherDialectOnly]),
		).rejects.toBeInstanceOf(DatabaseMigrationError);
		await expect(
			runDatabaseMigrations(db, 'notes.core', [otherDialectOnly]),
		).rejects.toMatchObject({ code: 'DIALECT_NOT_SUPPORTED' });
	});
});
