import { createHash } from 'node:crypto';

export const MIGRATION_LEDGER_TABLE = '_coreloom_migrations';

export type MigrationParameter = string | number | null;

export interface MigrationStatement {
	get(...parameters: readonly MigrationParameter[]): unknown;
	run(...parameters: readonly MigrationParameter[]): unknown;
	all(...parameters: readonly MigrationParameter[]): readonly unknown[];
}

/* Structural, so the kernel stays free of a driver dependency and tests can
   pass any SQLite handle. node:sqlite DatabaseSync satisfies it. */
export interface MigrationDatabase {
	exec(sql: string): void;
	prepare(sql: string): MigrationStatement;
}

export interface ModuleMigration {
	readonly id: string;
	readonly statements: string;
	/* Optional module-owned fingerprint check for a known pre-ledger schema.
	   It may inspect existing objects but must not write. Throw MigrationError
	   when a present object is incompatible; absence is a valid fresh install. */
	readonly validateExisting?: (database: MigrationDatabase) => void;
	/* Sole authority on adoption when supplied, for migrations whose effect is
	   rows rather than schema. It must also cover any DDL the statements carry. */
	readonly adoptWhen?: (database: MigrationDatabase) => boolean;
}

export type ModuleMigrationState =
	| 'applied'
	| 'pending'
	| 'adopted'
	| 'mismatch';

export interface ModuleMigrationStatusEntry {
	readonly id: string;
	readonly state: ModuleMigrationState;
	readonly checksum: string;
	readonly appliedAt: number | null;
	readonly reason?: string;
}

export type ModuleMigrationAction = 'applied' | 'adopted' | 'unchanged';

export interface ModuleMigrationResult {
	readonly id: string;
	readonly action: ModuleMigrationAction;
	readonly checksum: string;
}

export interface RunModuleMigrationsOptions {
	readonly dryRun?: boolean;
	readonly now?: () => number;
}

export type MigrationErrorCode =
	| 'DUPLICATE_MIGRATION_ID'
	| 'CHECKSUM_MISMATCH'
	| 'PARTIAL_OBJECTS'
	| 'APPLY_FAILED';

export class MigrationError extends Error {
	readonly code: MigrationErrorCode;
	readonly migrationId: string;

	constructor(
		code: MigrationErrorCode,
		migrationId: string,
		message: string,
		options?: { cause: unknown },
	) {
		super(message, options);
		this.name = 'MigrationError';
		this.code = code;
		this.migrationId = migrationId;
	}
}

type SchemaObjectKind = 'table' | 'index' | 'view' | 'trigger';

type DeclaredObject =
	| { readonly kind: SchemaObjectKind; readonly name: string }
	| { readonly kind: 'column'; readonly name: string; readonly table: string };

type Decision =
	| { readonly kind: 'unchanged'; readonly appliedAt: number }
	| { readonly kind: 'mismatch'; readonly recorded: string }
	| { readonly kind: 'adopt' }
	| { readonly kind: 'apply' }
	| { readonly kind: 'partial'; readonly missing: readonly string[] };

interface PlannedMigration {
	readonly migration: ModuleMigration;
	readonly checksum: string;
	readonly decision: Decision;
}

const CREATE_OBJECT =
	/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;

const ADD_COLUMN =
	/\bALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+ADD\s+(?:COLUMN\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/gi;

/* Comments and literal text must not be scanned for object names, or a name
   mentioned in prose would be read as a declaration and adopted. */
function scannable(sql: string): string {
	let out = '';
	for (let index = 0; index < sql.length; index += 1) {
		const character = sql[index]!;
		if (character === '-' && sql[index + 1] === '-') {
			while (index < sql.length && sql[index] !== '\n') index += 1;
			out += '\n';
			continue;
		}
		if (character === '/' && sql[index + 1] === '*') {
			index += 2;
			while (
				index < sql.length &&
				!(sql[index] === '*' && sql[index + 1] === '/')
			)
				index += 1;
			index += 1;
			out += ' ';
			continue;
		}
		if (character === "'") {
			index += 1;
			while (index < sql.length) {
				if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
				else if (sql[index] === "'") break;
				else index += 1;
			}
			out += "''";
			continue;
		}
		out += character;
	}
	return out;
}

function declaredObjects(statements: string): readonly DeclaredObject[] {
	const sql = scannable(statements);
	const objects: DeclaredObject[] = [];
	for (const match of sql.matchAll(CREATE_OBJECT)) {
		const name = match[2] ?? match[3];
		if (!name) continue;
		objects.push({
			kind: match[1]!.toLowerCase() as SchemaObjectKind,
			name,
		});
	}
	for (const match of sql.matchAll(ADD_COLUMN)) {
		const table = match[1] ?? match[2];
		const name = match[3] ?? match[4];
		if (!table || !name) continue;
		objects.push({ kind: 'column', name, table });
	}
	return objects;
}

function objectExists(
	database: MigrationDatabase,
	object: DeclaredObject,
): boolean {
	if (object.kind === 'column') {
		return (
			database
				.prepare('SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?')
				.get(object.table, object.name) !== undefined
		);
	}
	return (
		database
			.prepare(
				'SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?',
			)
			.get(object.kind, object.name) !== undefined
	);
}

function objectLabel(object: DeclaredObject): string {
	return object.kind === 'column'
		? `column ${object.table}.${object.name}`
		: `${object.kind} ${object.name}`;
}

/* Line endings and surrounding blank space are editor noise; everything else,
   including whitespace inside the SQL, is part of the checksum. */
export function moduleMigrationChecksum(statements: string): string {
	const normalized = statements.replace(/\r\n?/g, '\n').trim();
	return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

interface LedgerRow {
	readonly id: string;
	readonly checksum: string;
	readonly applied_at: number;
}

function ledger(
	database: MigrationDatabase,
): ReadonlyMap<string, { checksum: string; appliedAt: number }> {
	const present = database
		.prepare(
			'SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?',
		)
		.get('table', MIGRATION_LEDGER_TABLE);
	const rows = new Map<string, { checksum: string; appliedAt: number }>();
	if (present === undefined) return rows;
	for (const row of database
		.prepare(`SELECT id, checksum, applied_at FROM ${MIGRATION_LEDGER_TABLE}`)
		.all() as readonly LedgerRow[]) {
		rows.set(row.id, { checksum: row.checksum, appliedAt: row.applied_at });
	}
	return rows;
}

function assertUniqueIds(migrations: readonly ModuleMigration[]): void {
	const seen = new Set<string>();
	for (const migration of migrations) {
		if (seen.has(migration.id)) {
			throw new MigrationError(
				'DUPLICATE_MIGRATION_ID',
				migration.id,
				`Migration "${migration.id}" is listed twice.`,
			);
		}
		seen.add(migration.id);
	}
}

/* Decides one migration against the database as it stands right now. Callers
   that apply must re-ask per migration, because an earlier one in the same run
   creates the objects and rows a later decision reads. */
function decide(
	database: MigrationDatabase,
	migration: ModuleMigration,
): Decision {
	migration.validateExisting?.(database);
	if (migration.adoptWhen) {
		try {
			return migration.adoptWhen(database)
				? { kind: 'adopt' }
				: { kind: 'apply' };
		} catch {
			/* A predicate that cannot answer, typically because the table it reads
			   is created by a migration still ahead of it, is never an adoption. */
			return { kind: 'apply' };
		}
	}
	const objects = declaredObjects(migration.statements);
	if (objects.length === 0) return { kind: 'apply' };
	const missing = objects.filter((object) => !objectExists(database, object));
	if (missing.length === objects.length) return { kind: 'apply' };
	if (missing.length === 0) return { kind: 'adopt' };
	return { kind: 'partial', missing: missing.map(objectLabel) };
}

function plan(
	database: MigrationDatabase,
	migrations: readonly ModuleMigration[],
): readonly PlannedMigration[] {
	assertUniqueIds(migrations);
	const recorded = ledger(database);
	return migrations.map((migration) => {
		const checksum = moduleMigrationChecksum(migration.statements);
		const row = recorded.get(migration.id);
		if (!row)
			return { migration, checksum, decision: decide(database, migration) };
		return {
			migration,
			checksum,
			decision:
				row.checksum === checksum
					? { kind: 'unchanged', appliedAt: row.appliedAt }
					: { kind: 'mismatch', recorded: row.checksum },
		};
	});
}

export function moduleMigrationStatus(
	database: MigrationDatabase,
	migrations: readonly ModuleMigration[],
): readonly ModuleMigrationStatusEntry[] {
	return plan(database, migrations).map(({ migration, checksum, decision }) => {
		switch (decision.kind) {
			case 'unchanged':
				return {
					id: migration.id,
					state: 'applied',
					checksum,
					appliedAt: decision.appliedAt,
				};
			case 'mismatch':
				return {
					id: migration.id,
					state: 'mismatch',
					checksum,
					appliedAt: null,
					reason: `The ledger holds ${decision.recorded}; the migration now hashes to ${checksum}.`,
				};
			case 'adopt':
				return {
					id: migration.id,
					state: 'adopted',
					checksum,
					appliedAt: null,
				};
			case 'partial':
				return {
					id: migration.id,
					state: 'pending',
					checksum,
					appliedAt: null,
					reason: `Some objects already exist; missing: ${decision.missing.join(', ')}.`,
				};
			case 'apply':
				return {
					id: migration.id,
					state: 'pending',
					checksum,
					appliedAt: null,
				};
		}
	});
}

function action(decision: Decision): ModuleMigrationAction {
	if (decision.kind === 'unchanged') return 'unchanged';
	return decision.kind === 'adopt' ? 'adopted' : 'applied';
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
	id TEXT PRIMARY KEY,
	checksum TEXT NOT NULL,
	applied_at INTEGER NOT NULL
) STRICT;`;

function assertImmutable(
	recorded: ReadonlyMap<string, { checksum: string; appliedAt: number }>,
	migration: ModuleMigration,
	checksum: string,
): void {
	const row = recorded.get(migration.id);
	if (!row || row.checksum === checksum) return;
	throw new MigrationError(
		'CHECKSUM_MISMATCH',
		migration.id,
		`Migration "${migration.id}" was applied as ${row.checksum} but now hashes to ${checksum}. An applied migration is immutable; add a new one instead.`,
	);
}

export function runModuleMigrations(
	database: MigrationDatabase,
	migrations: readonly ModuleMigration[],
	options: RunModuleMigrationsOptions = {},
): readonly ModuleMigrationResult[] {
	assertUniqueIds(migrations);
	const recorded = ledger(database);
	const checksums = new Map<string, string>();
	/* Every applied migration is verified before a single statement runs, so an
	   edited file blocks the module instead of half-migrating it. */
	for (const migration of migrations) {
		const checksum = moduleMigrationChecksum(migration.statements);
		assertImmutable(recorded, migration, checksum);
		checksums.set(migration.id, checksum);
	}
	const outstanding = migrations.filter(
		(migration) => !recorded.has(migration.id),
	);
	const actions = new Map<string, ModuleMigrationAction>();

	if (options.dryRun) {
		for (const migration of outstanding) {
			actions.set(migration.id, action(decide(database, migration)));
		}
	} else if (outstanding.length > 0) {
		database.exec(LEDGER_DDL);
		const record = database.prepare(
			`INSERT INTO ${MIGRATION_LEDGER_TABLE} (id, checksum, applied_at) VALUES (?, ?, ?)`,
		);
		const recordedNow = database.prepare(
			`SELECT checksum FROM ${MIGRATION_LEDGER_TABLE} WHERE id = ?`,
		);
		const now = options.now ?? Date.now;
		for (const migration of outstanding) {
			const checksum = checksums.get(migration.id)!;
			database.exec('BEGIN IMMEDIATE');
			let decision: Decision;
			try {
				/* Re-read under the write lock. Another process, typically the running
				   server, may have applied this migration since the plan above. */
				const winner = recordedNow.get(migration.id) as
					| { checksum: string }
					| undefined;
				if (winner) {
					database.exec('ROLLBACK');
					if (winner.checksum !== checksum) {
						throw new MigrationError(
							'CHECKSUM_MISMATCH',
							migration.id,
							`Migration "${migration.id}" was applied as ${winner.checksum} but now hashes to ${checksum}. An applied migration is immutable; add a new one instead.`,
						);
					}
					continue;
				}
				decision = decide(database, migration);
				if (decision.kind === 'partial') {
					throw new MigrationError(
						'PARTIAL_OBJECTS',
						migration.id,
						`Migration "${migration.id}" is half present in this database and cannot be adopted or applied. Missing: ${decision.missing.join(', ')}.`,
					);
				}
				if (decision.kind === 'apply') database.exec(migration.statements);
				record.run(migration.id, checksum, now());
				database.exec('COMMIT');
			} catch (error) {
				try {
					database.exec('ROLLBACK');
				} catch {
					/* The failure already aborted the transaction; keep the real cause. */
				}
				if (error instanceof MigrationError) throw error;
				throw new MigrationError(
					'APPLY_FAILED',
					migration.id,
					`Migration "${migration.id}" failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			actions.set(migration.id, action(decision));
		}
	}
	return migrations.map((migration) => ({
		id: migration.id,
		action: actions.get(migration.id) ?? 'unchanged',
		checksum: checksums.get(migration.id)!,
	}));
}
