import { createHash } from 'node:crypto';
import {
	assertNamespace,
	assertSchemaName,
	DatabaseError,
	type DatabaseDialectId,
	type DatabaseHandle,
	type DatabaseSession,
	type DatabaseTransaction,
} from './contracts.ts';

export const DATABASE_MIGRATION_LEDGER = '_coreloom_migrations_v2';

/* Line endings and surrounding blank space are editor noise; everything else,
   including whitespace inside the SQL, is part of the checksum. Changing this
   normalization invalidates every checksum already recorded in a deployment. */
export function moduleMigrationChecksum(statements: string): string {
	const normalized = statements.replace(/\r\n?/g, '\n').trim();
	return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export type ExistingMigrationState = 'absent' | 'complete' | 'partial';

export interface DatabaseMigration {
	readonly id: string;
	readonly sql: Readonly<Record<DatabaseDialectId, string | undefined>>;
	/** Required only when a pre-ledger schema may already contain this change. */
	readonly inspectExisting?: (
		database: DatabaseSession,
	) => Promise<ExistingMigrationState>;
}

/* Adoption checks run inside the migration transaction, which is pinned to one
   connection. Thunks keep them strictly sequential: eagerly created promises
   would issue overlapping queries on that single client. */
export async function migrationObjectState(
	checks: readonly (() => Promise<boolean>)[],
): Promise<ExistingMigrationState> {
	const present: boolean[] = [];
	for (const check of checks) present.push(await check());
	if (present.every(Boolean)) return 'complete';
	if (present.some(Boolean)) return 'partial';
	return 'absent';
}

interface PostgresTenantTableRow {
	readonly rls_enabled: boolean;
	readonly rls_forced: boolean;
	readonly policy_present: boolean;
}

/**
 * A PostgreSQL tenant table counts as adopted only when its row-level security
 * is enabled, forced, and carries the named policy. A table without them is
 * partial, never complete, so the runner refuses instead of trusting it.
 */
export async function postgresTenantTableState(
	database: DatabaseSession,
	table: string,
	policy: string,
	extraChecks: readonly (() => Promise<boolean>)[] = [],
): Promise<ExistingMigrationState> {
	assertSchemaName(table);
	const tablePresent = await database.schema.hasTable(table);
	const extras: boolean[] = [];
	for (const check of extraChecks) extras.push(await check());
	if (!tablePresent && extras.every((present) => !present)) return 'absent';
	if (!tablePresent || extras.some((present) => !present)) return 'partial';
	const result = await database.query<PostgresTenantTableRow>({
		text: `SELECT relation.relrowsecurity AS rls_enabled,
		              relation.relforcerowsecurity AS rls_forced,
		              EXISTS (
		                SELECT 1 FROM pg_policy
		                WHERE polrelid = relation.oid AND polname = $2
		              ) AS policy_present
		       FROM pg_class AS relation
		       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		       WHERE namespace.nspname = current_schema() AND relation.relname = $1`,
		parameters: [table, policy],
	});
	const state = result.rows[0];
	return state?.rls_enabled && state.rls_forced && state.policy_present
		? 'complete'
		: 'partial';
}

export type DatabaseMigrationState =
	| 'applied'
	| 'pending'
	| 'partial'
	| 'adopted'
	| 'mismatch'
	| 'unsupported';

export interface DatabaseMigrationStatus {
	readonly id: string;
	readonly state: DatabaseMigrationState;
	readonly checksum: string | null;
	readonly appliedAt: number | null;
	readonly reason?: string;
}

export type DatabaseMigrationAction = 'applied' | 'adopted' | 'unchanged';

export interface DatabaseMigrationResult {
	readonly id: string;
	readonly action: DatabaseMigrationAction;
	readonly checksum: string;
}

export interface RunDatabaseMigrationsOptions {
	readonly dryRun?: boolean;
	readonly now?: () => number;
}

export type DatabaseMigrationErrorCode =
	| 'CHECKSUM_MISMATCH'
	| 'DIALECT_NOT_SUPPORTED'
	| 'DUPLICATE_MIGRATION_ID'
	| 'APPLY_FAILED'
	| 'PARTIAL_MIGRATION'
	| 'WRONG_LEDGER_DIALECT';

export class DatabaseMigrationError extends Error {
	constructor(
		readonly code: DatabaseMigrationErrorCode,
		readonly migrationId: string,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = 'DatabaseMigrationError';
	}
}

interface LedgerRow {
	readonly id: string;
	readonly dialect: string;
	readonly checksum: string;
	readonly applied_at: number | bigint | string;
}

function assertMigrationId(id: string): void {
	if (!/^[0-9]{4}_[a-z][a-z0-9_]{0,122}$/.test(id)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			`"${id}" is not a valid migration id.`,
		);
	}
}

function assertMigrations(migrations: readonly DatabaseMigration[]): void {
	const seen = new Set<string>();
	for (const migration of migrations) {
		assertMigrationId(migration.id);
		if (seen.has(migration.id)) {
			throw new DatabaseMigrationError(
				'DUPLICATE_MIGRATION_ID',
				migration.id,
				`Migration "${migration.id}" is listed twice.`,
			);
		}
		seen.add(migration.id);
	}
}

function sqlFor(
	migration: DatabaseMigration,
	dialectId: DatabaseDialectId,
): string {
	const sql = migration.sql[dialectId];
	if (!sql) {
		throw new DatabaseMigrationError(
			'DIALECT_NOT_SUPPORTED',
			migration.id,
			`Migration "${migration.id}" has no ${dialectId} SQL.`,
		);
	}
	return sql;
}

async function ledgerExists(database: DatabaseSession): Promise<boolean> {
	return database.schema.hasTable(DATABASE_MIGRATION_LEDGER);
}

async function ledgerRows(
	database: DatabaseSession,
	namespace: string,
): Promise<ReadonlyMap<string, LedgerRow>> {
	if (!(await ledgerExists(database))) return new Map();
	const marker = database.capabilities.sql.placeholder(1);
	const result = await database.query<LedgerRow>({
		text: `SELECT id, dialect, checksum, applied_at
		 FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = ${marker}`,
		parameters: [namespace],
	});
	return new Map(result.rows.map((row) => [row.id, row]));
}

function appliedAt(value: LedgerRow['applied_at']): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'The migration ledger contains an invalid applied_at value.',
		);
	}
	return result;
}

async function stateOf(
	database: DatabaseSession,
	migration: DatabaseMigration,
	row: LedgerRow | undefined,
): Promise<DatabaseMigrationStatus> {
	const sql = migration.sql[database.dialectId];
	if (!sql) {
		return {
			id: migration.id,
			state: 'unsupported',
			checksum: null,
			appliedAt: null,
			reason: `No ${database.dialectId} SQL is declared.`,
		};
	}
	const checksum = moduleMigrationChecksum(sql);
	if (row) {
		if (row.dialect !== database.dialectId) {
			return {
				id: migration.id,
				state: 'mismatch',
				checksum,
				appliedAt: appliedAt(row.applied_at),
				reason: `The ledger records dialect ${row.dialect}.`,
			};
		}
		return row.checksum === checksum
			? {
					id: migration.id,
					state: 'applied',
					checksum,
					appliedAt: appliedAt(row.applied_at),
				}
			: {
					id: migration.id,
					state: 'mismatch',
					checksum,
					appliedAt: appliedAt(row.applied_at),
					reason: `The ledger holds ${row.checksum}; the migration now hashes to ${checksum}.`,
				};
	}
	const existing = await migration.inspectExisting?.(database);
	return {
		id: migration.id,
		state:
			existing === 'complete'
				? 'adopted'
				: existing === 'partial'
					? 'partial'
					: 'pending',
		checksum,
		appliedAt: null,
		...(existing === 'partial'
			? { reason: 'The migration is only partially present.' }
			: {}),
	};
}

export async function databaseMigrationStatus(
	database: DatabaseHandle,
	namespace: string,
	migrations: readonly DatabaseMigration[],
): Promise<readonly DatabaseMigrationStatus[]> {
	assertNamespace(namespace);
	assertMigrations(migrations);
	const rows = await ledgerRows(database, namespace);
	return Promise.all(
		migrations.map((migration) =>
			stateOf(database, migration, rows.get(migration.id)),
		),
	);
}

function mismatchError(
	dialectId: DatabaseDialectId,
	migration: DatabaseMigration,
	row: LedgerRow,
	checksum: string,
): DatabaseMigrationError | null {
	if (row.dialect !== dialectId) {
		return new DatabaseMigrationError(
			'WRONG_LEDGER_DIALECT',
			migration.id,
			`Migration "${migration.id}" was recorded for ${row.dialect}, not ${dialectId}.`,
		);
	}
	if (row.checksum === checksum) return null;
	return new DatabaseMigrationError(
		'CHECKSUM_MISMATCH',
		migration.id,
		`Migration "${migration.id}" was applied as ${row.checksum} but now hashes to ${checksum}.`,
	);
}

async function recordMigration(
	database: DatabaseTransaction,
	namespace: string,
	migration: DatabaseMigration,
	checksum: string,
	now: number,
): Promise<void> {
	const values = [namespace, migration.id, database.dialectId, checksum, now];
	const markers = values
		.map((_, index) => database.capabilities.sql.placeholder(index + 1))
		.join(', ');
	await database.execute({
		text: `INSERT INTO ${DATABASE_MIGRATION_LEDGER}
		 (namespace, id, dialect, checksum, applied_at) VALUES (${markers})`,
		parameters: values,
	});
}

export async function runDatabaseMigrations(
	database: DatabaseHandle,
	namespace: string,
	migrations: readonly DatabaseMigration[],
	options: RunDatabaseMigrationsOptions = {},
): Promise<readonly DatabaseMigrationResult[]> {
	assertNamespace(namespace);
	assertMigrations(migrations);
	if (!database.capabilities.transactionalDdl) {
		throw new DatabaseError(
			'UNSUPPORTED_CAPABILITY',
			'Flowdular migrations require transactional DDL.',
		);
	}
	if (options.dryRun) {
		const statuses = await databaseMigrationStatus(
			database,
			namespace,
			migrations,
		);
		return statuses.map((status) => {
			if (status.checksum === null) {
				throw new DatabaseMigrationError(
					'DIALECT_NOT_SUPPORTED',
					status.id,
					status.reason ?? 'The database dialect is unsupported.',
				);
			}
			if (status.state === 'mismatch') {
				throw new DatabaseMigrationError(
					'CHECKSUM_MISMATCH',
					status.id,
					status.reason ?? 'The migration checksum does not match.',
				);
			}
			if (status.state === 'partial') {
				throw new DatabaseMigrationError(
					'PARTIAL_MIGRATION',
					status.id,
					status.reason ?? 'The migration is only partially present.',
				);
			}
			return {
				id: status.id,
				action:
					status.state === 'applied'
						? 'unchanged'
						: status.state === 'adopted'
							? 'adopted'
							: 'applied',
				checksum: status.checksum,
			};
		});
	}

	return database.transaction(
		async (transaction) => {
			await transaction.acquireMigrationLock(namespace);
			await transaction.executeScript(
				database.capabilities.sql.migrationLedgerDdl(DATABASE_MIGRATION_LEDGER),
			);
			const rows = await ledgerRows(transaction, namespace);
			const checksums = new Map<string, string>();
			for (const migration of migrations) {
				const sql = sqlFor(migration, database.dialectId);
				const checksum = moduleMigrationChecksum(sql);
				checksums.set(migration.id, checksum);
				const row = rows.get(migration.id);
				if (!row) continue;
				const error = mismatchError(
					database.dialectId,
					migration,
					row,
					checksum,
				);
				if (error) throw error;
			}

			const actions = new Map<string, DatabaseMigrationAction>();
			for (const migration of migrations) {
				if (rows.has(migration.id)) continue;
				try {
					const existing = await migration.inspectExisting?.(transaction);
					if (existing === 'partial') {
						throw new DatabaseMigrationError(
							'PARTIAL_MIGRATION',
							migration.id,
							`Migration "${migration.id}" is only partially present.`,
						);
					}
					const sql = sqlFor(migration, database.dialectId);
					if (existing !== 'complete') await transaction.executeScript(sql);
					await recordMigration(
						transaction,
						namespace,
						migration,
						checksums.get(migration.id)!,
						(options.now ?? Date.now)(),
					);
					actions.set(
						migration.id,
						existing === 'complete' ? 'adopted' : 'applied',
					);
				} catch (error) {
					if (error instanceof DatabaseMigrationError) throw error;
					throw new DatabaseMigrationError(
						'APPLY_FAILED',
						migration.id,
						`Migration "${migration.id}" failed and was rolled back.`,
						{ cause: error },
					);
				}
			}
			return migrations.map((migration) => ({
				id: migration.id,
				action: actions.get(migration.id) ?? 'unchanged',
				checksum: checksums.get(migration.id)!,
			}));
		},
		{ access: 'write', isolation: 'serializable' },
	);
}
