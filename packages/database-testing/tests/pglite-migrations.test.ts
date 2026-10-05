import { createPgliteCluster } from '@flowdular/database-pglite';
import { afterAll, describe, expect, it } from 'vitest';
import {
	assertNotLegacyDatabase,
	DATABASE_MIGRATION_LEDGER,
	DatabaseMigrationError,
	PostgresDatabaseAdapter,
	databaseMigrationStatus,
	postgresTenantTableState,
	runDatabaseMigrations,
	type DatabaseMigration,
} from '@flowdular/database';

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

function tenantNotes(using: string, withCheck = using): string {
	return `CREATE TABLE IF NOT EXISTS tenant_notes (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL
);
ALTER TABLE tenant_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_notes_tenant_policy ON tenant_notes
	USING (tenant_id = current_setting('${using}', true))
	WITH CHECK (tenant_id = current_setting('${withCheck}', true));
`;
}

const CREATE_TENANT_NOTES: DatabaseMigration = {
	id: '0001_tenant_notes',
	sql: { postgresql: tenantNotes('flowdular.tenant_id') },
	inspectExisting: (database) =>
		postgresTenantTableState(
			database,
			'tenant_notes',
			'tenant_notes_tenant_policy',
		),
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
		`DROP TABLE IF EXISTS notes, tenant_notes, only_postgres, ${DATABASE_MIGRATION_LEDGER} CASCADE;`,
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

	/* A 0.5 database holds complete-looking tables whose policies read a setting
	   the adapter no longer sets. Adopting them would pass every inspection. */
	it('refuses a database created before the rename without writing to it', async () => {
		const db = await database();
		await db.executeScript(`${CREATE_NOTES.sql.postgresql!}
CREATE TABLE _coreloom_migrations_v2 (
	namespace TEXT NOT NULL,
	id TEXT NOT NULL,
	dialect TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at BIGINT NOT NULL,
	PRIMARY KEY (namespace, id)
);
INSERT INTO _coreloom_migrations_v2 VALUES ('notes.core', '0001_notes_core', 'postgresql', 'sha256:legacy', 1);
`);
		try {
			for (const attempt of [
				() => runDatabaseMigrations(db, 'notes.core', [CREATE_NOTES]),
				() =>
					runDatabaseMigrations(db, 'notes.core', [CREATE_NOTES, ADD_PINNED], {
						dryRun: true,
					}),
				() => databaseMigrationStatus(db, 'notes.core', [CREATE_NOTES]),
			]) {
				await expect(attempt()).rejects.toMatchObject({
					code: 'LEGACY_DATABASE',
				});
			}
			await expect(db.schema.hasTable(DATABASE_MIGRATION_LEDGER)).resolves.toBe(
				false,
			);
			await expect(db.schema.hasColumn('notes', 'pinned')).resolves.toBe(false);
		} finally {
			await db.executeScript('DROP TABLE _coreloom_migrations_v2;');
		}
	});

	/* The Vercel launcher provisions roles on a plain pg session before any
	   migration runs, so it needs the same refusal without a migration lease. */
	it('refuses a database created before the rename to a plain SQL text session', async () => {
		const db = await database();
		const session = { query: (text: string) => db.query({ text }) };
		await expect(assertNotLegacyDatabase(session)).resolves.toBeUndefined();
		await db.executeScript(
			'CREATE TABLE _coreloom_migrations_v2 (namespace TEXT, id TEXT);',
		);
		try {
			await expect(assertNotLegacyDatabase(session)).rejects.toMatchObject({
				code: 'LEGACY_DATABASE',
				message: expect.stringContaining('Flowdular 0.5 or earlier'),
			});
		} finally {
			await db.executeScript('DROP TABLE _coreloom_migrations_v2;');
		}
	});

	/* information_schema lists only tables the current role holds a privilege
	   on, and the old ledger belongs to the old migrator role. */
	it('refuses an old ledger the migrating role holds no privilege on', async () => {
		const db = await database();
		await db.executeScript(`CREATE TABLE _coreloom_migrations_v2 (
	namespace TEXT NOT NULL,
	id TEXT NOT NULL,
	PRIMARY KEY (namespace, id)
);
REVOKE ALL ON _coreloom_migrations_v2 FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration_probe') THEN
    CREATE ROLE migration_probe NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO migration_probe;
`);
		const probe = new PostgresDatabaseAdapter({
			pool: cluster.pool('migration_probe'),
		});
		try {
			await expect(
				probe.schema.hasTable('_coreloom_migrations_v2'),
			).resolves.toBe(false);
			await expect(
				databaseMigrationStatus(probe, 'notes.core', [CREATE_NOTES]),
			).rejects.toMatchObject({ code: 'LEGACY_DATABASE' });
		} finally {
			await probe.dispose();
			await db.executeScript('DROP TABLE _coreloom_migrations_v2;');
		}
	});

	/* Dropping only the old ledger leaves tables whose policies still read the
	   old setting. Adopting them would pass every other inspection while every
	   policy sees no tenant. */
	it.each([
		['both clauses', 'coreloom.tenant_id', 'coreloom.tenant_id'],
		['the USING clause', 'coreloom.tenant_id', 'flowdular.tenant_id'],
		['the WITH CHECK clause', 'flowdular.tenant_id', 'coreloom.tenant_id'],
	])(
		'refuses to adopt a tenant table whose policy reads another setting in %s',
		async (_label, using, withCheck) => {
			const db = await database();
			await db.executeScript(tenantNotes(using, withCheck));

			await expect(
				runDatabaseMigrations(db, 'notes.core', [CREATE_TENANT_NOTES]),
			).rejects.toMatchObject({ code: 'PARTIAL_MIGRATION' });
		},
	);

	it('adopts a tenant table whose policy reads the flowdular setting', async () => {
		const db = await database();
		await db.executeScript(tenantNotes('flowdular.tenant_id'));

		const result = await runDatabaseMigrations(db, 'notes.core', [
			CREATE_TENANT_NOTES,
		]);

		expect(result[0]?.action).toBe('adopted');
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
