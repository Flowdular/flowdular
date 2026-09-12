import { readFileSync } from 'node:fs';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
	type DatabaseAdapterLease,
	type DatabaseHandle,
	type DatabaseProvider,
} from '@flowdular/database';
import {
	createPgliteTestProvider,
	createTestDatabaseProvider,
} from '@flowdular/database-testing';
import {
	AUDIT_TENANT_TABLES,
	databaseMigrations,
} from '../src/services/migration.ts';
import { migrateAuditDatabase } from '../src/services/database-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

/** Exactly the columns migration 0002 grants; anything else is a leak. */
const ROUTING_COLUMNS = [
	'tenant_id',
	'class_id',
	'sweepable',
	'retention_mode',
	'retention_days',
	'default_retention_days',
	'last_swept_at',
] as const;

const WITHHELD_COLUMNS = ['id', 'module_id', 'label', 'exportable'] as const;

/** Exactly the columns migration 0003 grants; anything else is a leak. */
const EXPORT_ROUTING_COLUMNS = [
	'tenant_id',
	'id',
	'status',
	'started_at',
] as const;

const EXPORT_WITHHELD_COLUMNS = [
	'requested_by',
	'output_directory',
	'archive_path',
	'archive_digest',
	'summary_json',
] as const;

/** Exactly the columns migration 0004 grants; anything else is a leak. */
const ANCHOR_ROUTING_COLUMNS = ['tenant_id', 'id', 'key_id'] as const;

const ANCHOR_WITHHELD_COLUMNS = [
	'anchor_hash',
	'segment_hash',
	'signature',
	'segment_file',
	'sealed_by',
] as const;

const ERASURE_ROUTING_COLUMNS = [
	'tenant_id',
	'id',
	'status',
	'started_at',
] as const;

const ERASURE_WITHHELD_COLUMNS = [
	'subject',
	'subject_marker',
	'requested_by',
	'certificate_path',
	'outcome_json',
] as const;

/** Tables the background role reads routing columns of; every other is opaque. */
const ROUTED_TABLES = new Set<string>([
	'audit_data_classes',
	'audit_export_runs',
	'audit_anchors',
	'audit_erasure_runs',
]);

let providers: DatabaseProvider[] = [];

afterEach(async () => {
	const open = providers;
	providers = [];
	for (const provider of open) await provider.dispose();
});

async function migrator(): Promise<DatabaseHandle> {
	const provider = createPgliteTestProvider();
	providers.push(provider);
	const lease = await provider.acquire({
		namespace: 'audit.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('audit migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies every migration once and records it in the ledger', async () => {
		const database = await migrator();
		const applied = await runDatabaseMigrations(
			database,
			'audit.core',
			databaseMigrations,
		);
		expect(applied.map((result) => [result.id, result.action])).toEqual(
			databaseMigrations.map((migration) => [migration.id, 'applied']),
		);
		const ledger = await database.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: `SELECT id FROM ${DATABASE_MIGRATION_LEDGER}
					 WHERE namespace = $1 ORDER BY id`,
					parameters: ['audit.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'audit.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateAuditDatabase(database);
		for (const table of AUDIT_TENANT_TABLES) {
			const security = await database.transaction(
				(transaction) =>
					transaction.query<RelationSecurity>({
						text: `SELECT relation.relrowsecurity, relation.relforcerowsecurity,
						              (SELECT count(*) FROM pg_policy
						               WHERE polrelid = relation.oid
						                 AND polname = $2) AS policies
						       FROM pg_class AS relation
						       JOIN pg_namespace AS namespace
						         ON namespace.oid = relation.relnamespace
						       WHERE namespace.nspname = current_schema()
						         AND relation.relname = $1`,
						parameters: [table, `${table}_tenant_policy`],
					}),
				{ access: 'read' },
			);
			expect([table, security.rows[0]?.relrowsecurity]).toEqual([table, true]);
			expect([table, security.rows[0]?.relforcerowsecurity]).toEqual([
				table,
				true,
			]);
			expect([table, Number(security.rows[0]?.policies)]).toEqual([table, 1]);
		}
	});

	it('grants the background role the routing columns and nothing else', async () => {
		const database = await migrator();
		await migrateAuditDatabase(database);
		const granted = async (table: string, column: string) =>
			(
				await database.transaction(
					(transaction) =>
						transaction.query<{ allowed: boolean }>({
							text: `SELECT has_column_privilege('coreloom_background',
							 $1, $2, 'SELECT') AS allowed`,
							parameters: [table, column],
						}),
					{ access: 'read' },
				)
			).rows[0]?.allowed;

		for (const column of ROUTING_COLUMNS) {
			expect([column, await granted('audit_data_classes', column)]).toEqual([
				column,
				true,
			]);
		}
		for (const column of WITHHELD_COLUMNS) {
			expect([column, await granted('audit_data_classes', column)]).toEqual([
				column,
				false,
			]);
		}
		/* The export loop finds requested runs the same way, and is granted the
		   routing columns of audit_export_runs alone. */
		for (const column of EXPORT_ROUTING_COLUMNS) {
			expect([column, await granted('audit_export_runs', column)]).toEqual([
				column,
				true,
			]);
		}
		for (const column of EXPORT_WITHHELD_COLUMNS) {
			expect([column, await granted('audit_export_runs', column)]).toEqual([
				column,
				false,
			]);
		}
		/* The anchor rotation and the erasure loop find their work across
		   workspaces the same way, and are granted the routing columns alone. */
		for (const column of ANCHOR_ROUTING_COLUMNS) {
			expect([column, await granted('audit_anchors', column)]).toEqual([
				column,
				true,
			]);
		}
		for (const column of ANCHOR_WITHHELD_COLUMNS) {
			expect([column, await granted('audit_anchors', column)]).toEqual([
				column,
				false,
			]);
		}
		for (const column of ERASURE_ROUTING_COLUMNS) {
			expect([column, await granted('audit_erasure_runs', column)]).toEqual([
				column,
				true,
			]);
		}
		for (const column of ERASURE_WITHHELD_COLUMNS) {
			expect([column, await granted('audit_erasure_runs', column)]).toEqual([
				column,
				false,
			]);
		}
		for (const table of AUDIT_TENANT_TABLES) {
			if (ROUTED_TABLES.has(table)) continue;
			expect([table, await granted(table, 'tenant_id')]).toEqual([
				table,
				false,
			]);
		}
	});
});

describe('audit migration ledger', () => {
	let ledgerProvider: DatabaseProvider;
	let lease: DatabaseAdapterLease;

	beforeAll(async () => {
		ledgerProvider = createTestDatabaseProvider();
		lease = await ledgerProvider.acquire({
			namespace: 'audit.core',
			purpose: 'migration',
		});
	});

	afterAll(async () => {
		await lease?.release();
		await ledgerProvider?.dispose();
	});

	/* Every case states its own starting point, so the shared cluster goes back
	   to an unmigrated, unrecorded schema first. */
	beforeEach(async () => {
		await lease.database.execute({
			text: 'DROP SCHEMA IF EXISTS shadow CASCADE',
		});
		const tables = await lease.database.query<{ tablename: string }>({
			text: `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
		});
		if (tables.rows.length === 0) return;
		await lease.database.execute({
			text: `DROP TABLE ${tables.rows
				.map((row) => `"${row.tablename}"`)
				.join(', ')} CASCADE`,
		});
	});

	const apply = (migrations = databaseMigrations) =>
		runDatabaseMigrations(lease.database, 'audit.core', migrations);

	const status = () =>
		databaseMigrationStatus(lease.database, 'audit.core', databaseMigrations);

	const hasColumn = async (table: string, column: string) =>
		(
			await lease.database.query<{ present: boolean }>({
				text: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
				 WHERE table_schema = current_schema() AND table_name = $1
				   AND column_name = $2) AS present`,
				parameters: [table, column],
			})
		).rows[0]?.present === true;

	const forgetLedger = () =>
		lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'audit.core'`,
		});

	it('reports pending before the first pass', async () => {
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});

	it('adopts a schema that predates the ledger without changing its rows', async () => {
		await apply();
		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO audit_data_classes
					 (id, tenant_id, class_id, module_id, label, exportable, sweepable,
					  default_retention_days, retention_mode, retention_days,
					  last_swept_at, created_at, updated_at)
					 VALUES ('class-1', 'tenant-a', 'agents.core.runs', 'agents.core',
					  'Agent runs', 1, 1, 90, 'default', NULL, NULL, 1, 1)`,
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);
		await forgetLedger();

		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect(
			(
				await lease.database.transaction(
					(transaction) =>
						transaction.query<{ label: string }>({
							text: 'SELECT label FROM audit_data_classes',
						}),
					{ access: 'read', tenantId: 'tenant-a' },
				)
			).rows,
		).toEqual([{ label: 'Agent runs' }]);
	});

	/* The 0004 probe has to prove the columns, indexes and constraints the
	   migration adds, not only its three tables: a schema that carries the
	   tables and lost a column is partial, and adopting it would leave the
	   sweep ledger without the column its writes name. */
	it('reports a schema missing held_back as partial rather than adopting it', async () => {
		await apply();
		await lease.database.execute({
			text: 'ALTER TABLE audit_sweep_runs DROP COLUMN held_back',
		});
		await forgetLedger();

		const states = await status();
		expect(states.map((entry) => [entry.id, entry.state])).toContainEqual([
			'0004_audit_hold_seal_erasure',
			'partial',
		]);
		await expect(apply()).rejects.toMatchObject({
			code: 'PARTIAL_MIGRATION',
			migrationId: '0004_audit_hold_seal_erasure',
		});
	});

	it('reports a schema missing a 0004 index as partial', async () => {
		await apply();
		await lease.database.execute({
			text: 'DROP INDEX audit_erasure_runs_pending_idx',
		});
		await forgetLedger();

		expect(
			(await status()).map((entry) => [entry.id, entry.state]),
		).toContainEqual(['0004_audit_hold_seal_erasure', 'partial']);
	});

	/* An adoption probe answers for the schema the migration runs in. A table of
	   the same name in another schema on the search path used to satisfy the
	   column probe, so the migration was adopted and the real table never got
	   the column. */
	it('ignores a same-named table in another schema when probing for adoption', async () => {
		await apply(databaseMigrations.slice(0, 2));
		await lease.database.execute({ text: 'CREATE SCHEMA shadow' });
		await lease.database.execute({
			text: 'CREATE TABLE shadow.audit_export_runs (summary_json TEXT)',
		});
		expect(await hasColumn('audit_export_runs', 'summary_json')).toBe(false);

		const applied = await apply();

		expect(
			applied.find((entry) => entry.id === '0003_audit_export_request')?.action,
		).toBe('applied');
		expect(await hasColumn('audit_export_runs', 'summary_json')).toBe(true);
	});

	describe('AUDIT-MIGRATION-CONSTRAINT-PROBE', () => {
		/* Migrations 0003, 0004 and 0005 add their constraints inside DO blocks that
		   read pg_constraint by name alone, and those files are applied and cannot
		   be edited. The adoption probes are in code, so they are where the
		   schema-scoped check belongs: a schema whose constraint is gone must be
		   reported partial instead of adopted with the check missing for ever. */
		it('reports a schema missing a constraint of 0005 as partial', async () => {
			await apply();
			await lease.database.execute({
				text: 'ALTER TABLE audit_subject_keys DROP CONSTRAINT audit_subject_keys_marker_check',
			});
			await forgetLedger();

			expect(
				(await status()).map((entry) => [entry.id, entry.state]),
			).toContainEqual(['0005_audit_event_format', 'partial']);
			await expect(apply()).rejects.toMatchObject({
				code: 'PARTIAL_MIGRATION',
				migrationId: '0005_audit_event_format',
			});
		});

		/* PostgreSQL names an inline column check after its table and column, so
		   0004 and 0005 both hold a constraint called audit_erasure_runs_status_check
		   and only the widened definition carries 'partial'. Probing the name alone
		   would adopt a schema whose erasure runs can never be recorded partial. */
		it('reports a schema whose 0005 status constraint is still the one 0004 created as partial', async () => {
			await apply();
			await lease.database.execute({
				text: `ALTER TABLE audit_erasure_runs
				 DROP CONSTRAINT audit_erasure_runs_status_check`,
			});
			await lease.database.execute({
				text: `ALTER TABLE audit_erasure_runs
				 ADD CONSTRAINT audit_erasure_runs_status_check
				 CHECK (status IN ('requested', 'completed', 'failed'))`,
			});
			await forgetLedger();

			expect(
				(await status()).map((entry) => [entry.id, entry.state]),
			).toContainEqual(['0005_audit_event_format', 'partial']);
		});

		it('reports a schema missing an index of 0006 as partial', async () => {
			await apply();
			await lease.database.execute({
				text: 'DROP INDEX audit_legal_holds_tenant_account_idx',
			});
			await forgetLedger();

			expect(
				(await status()).map((entry) => [entry.id, entry.state]),
			).toContainEqual(['0006_audit_own_class_walks', 'partial']);
		});
	});

	it('reports a ledger entry that no longer matches its migration', async () => {
		await apply();
		const drifted = databaseMigrations[0]!.id;
		await lease.database.execute({
			text: `UPDATE ${DATABASE_MIGRATION_LEDGER}
			       SET checksum = 'sha256:drifted'
			       WHERE namespace = 'audit.core' AND id = $1`,
			parameters: [drifted],
		});

		expect((await status())[0]).toMatchObject({
			id: drifted,
			state: 'mismatch',
		});
		await expect(apply()).rejects.toMatchObject({
			code: 'CHECKSUM_MISMATCH',
			migrationId: drifted,
		});
	});

	it('writes nothing on a dry run', async () => {
		const planned = await runDatabaseMigrations(
			lease.database,
			'audit.core',
			databaseMigrations,
			{ dryRun: true },
		);

		expect(planned.map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		expect(
			(
				await lease.database.query<{ tablename: string }>({
					text: `SELECT tablename FROM pg_tables
					 WHERE schemaname = current_schema() AND tablename LIKE 'audit_%'`,
				})
			).rows,
		).toEqual([]);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});

	/* The ledger walks and the anchor rotation read these; a missing index turns
	   each page of a keyset walk into a scan of the whole table. */
	it('creates the index every bounded walk of 0005 depends on', async () => {
		await apply();

		const indexes = (
			await lease.database.query<{ indexname: string }>({
				text: `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
			})
		).rows.map((row) => row.indexname);
		expect(indexes).toEqual(
			expect.arrayContaining([
				'audit_events_tenant_id_idx',
				'audit_sweep_runs_tenant_id_idx',
				'audit_export_runs_tenant_id_idx',
				'audit_anchors_key_id_idx',
				'audit_subject_keys_tenant_marker_idx',
				'audit_data_classes_due_nulls_first_idx',
				/* The keyset walks of the two classes 0006 added, and the count an
				   erasure plan takes over the holds naming one account. */
				'audit_legal_holds_tenant_id_idx',
				'audit_erasure_runs_tenant_id_idx',
				'audit_legal_holds_tenant_account_idx',
			]),
		);
		/* The routing read orders by last_swept_at NULLS FIRST, so the index that
		   sorted nulls last no longer exists to be chosen by mistake. */
		expect(indexes).not.toContain('audit_data_classes_due_idx');
	});
});
