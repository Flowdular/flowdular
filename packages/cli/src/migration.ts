import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { failure, success, type CommandEnvelope } from '@coreloom/cli-protocol';
import type { ModuleManifest } from '@coreloom/contracts';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationChecksum,
	moduleMigrationStatus,
	runModuleMigrations,
	type MigrationDatabase,
	type ModuleMigration,
} from '@coreloom/kernel';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { findNamedFiles } from './validation.ts';
import type { Workspace } from './workspace.ts';

export interface MigrationModule {
	readonly moduleId: string;
	readonly databasePath: string;
	readonly migrations: readonly ModuleMigration[];
}

export interface UnmanagedModule {
	readonly moduleId: string;
	readonly reason: string;
}

export interface MigrationModules {
	readonly managed: readonly MigrationModule[];
	readonly unmanaged: readonly UnmanagedModule[];
}

/* Mirrors src/server/runtime.ts in every module: one SQLite file per module
   namespace, overridable per module by an environment variable. */
function databasePath(workspaceRoot: string, moduleId: string): string {
	const namespace = moduleId.split('.')[0] ?? moduleId;
	const override = process.env[`CL_${namespace.toUpperCase()}_DATABASE`];
	if (override) return override;
	return process.env.NODE_ENV === 'production'
		? `/data/${namespace}.db`
		: coreloomLocalDataPath(workspaceRoot, `${namespace}.db`);
}

function displayPath(workspaceRoot: string, path: string): string {
	const inside = relative(workspaceRoot, path);
	return inside.startsWith('..') || isAbsolute(inside) ? path : inside;
}

export async function loadMigrationModules(
	workspace: Workspace,
	moduleId?: string,
): Promise<MigrationModules> {
	const enabled = new Set(
		(workspace.config.modules as { enabled?: string[] } | undefined)?.enabled ??
			[],
	);
	const manifests = (
		await findNamedFiles(workspace.root, 'module.json')
	).filter((path) => path.includes('/modules/'));
	const managed: MigrationModule[] = [];
	const unmanaged: UnmanagedModule[] = [];
	for (const manifestPath of manifests) {
		const manifest = JSON.parse(
			await readFile(manifestPath, 'utf8'),
		) as ModuleManifest;
		if (!enabled.has(manifest.id)) continue;
		if (moduleId && manifest.id !== moduleId) continue;
		const entry = join(dirname(manifestPath), 'src/services/migration.ts');
		let migrations: unknown;
		try {
			({ migrations } = (await import(pathToFileURL(entry).href)) as {
				migrations?: unknown;
			});
		} catch {
			continue;
		}
		if (!Array.isArray(migrations)) {
			unmanaged.push({
				moduleId: manifest.id,
				reason:
					'src/services/migration.ts exports no "migrations" list; the module still runs SQL constants on repository construction.',
			});
			continue;
		}
		managed.push({
			moduleId: manifest.id,
			databasePath: databasePath(workspace.root, manifest.id),
			migrations: migrations as readonly ModuleMigration[],
		});
	}
	return { managed, unmanaged };
}

function open(path: string, readOnly: boolean): DatabaseSync {
	return new DatabaseSync(path, { readOnly, timeout: 5000 });
}

interface LedgerRow {
	readonly id: string;
	readonly checksum: string;
	readonly applied_at: number;
}

function ledgerRows(database: MigrationDatabase): readonly LedgerRow[] {
	const present = database
		.prepare(
			'SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?',
		)
		.get('table', MIGRATION_LEDGER_TABLE);
	if (present === undefined) return [];
	return database
		.prepare(
			`SELECT id, checksum, applied_at FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`,
		)
		.all() as readonly LedgerRow[];
}

function moduleFilterFailure(
	modules: MigrationModules,
	moduleId: string | undefined,
): CommandEnvelope | undefined {
	if (!moduleId || modules.managed.length > 0) return undefined;
	const unmanaged = modules.unmanaged.find(
		(entry) => entry.moduleId === moduleId,
	);
	return failure(
		unmanaged ? 'MODULE_NOT_MIGRATED' : 'MODULE_NOT_FOUND',
		unmanaged
			? `Module "${moduleId}" does not use the migration runner yet: ${unmanaged.reason}`
			: `No enabled module "${moduleId}" with migrations.`,
	);
}

export async function migrationStatus(
	workspace: Workspace,
	moduleId?: string,
): Promise<CommandEnvelope> {
	const modules = await loadMigrationModules(workspace, moduleId);
	const refusal = moduleFilterFailure(modules, moduleId);
	if (refusal) return refusal;

	const counters = { applied: 0, adopted: 0, pending: 0, mismatch: 0 };
	const reports = modules.managed.map((module) => {
		const path = displayPath(workspace.root, module.databasePath);
		let database: DatabaseSync;
		try {
			database = open(module.databasePath, true);
		} catch (error) {
			counters.pending += module.migrations.length;
			return {
				moduleId: module.moduleId,
				database: path,
				databaseExists: false,
				ledger: 0,
				note: `The database has not been opened yet (${error instanceof Error ? error.message : String(error)}). Every migration runs on first boot.`,
				migrations: module.migrations.map((migration) => ({
					id: migration.id,
					state: 'pending' as const,
					checksum: moduleMigrationChecksum(migration.statements),
					appliedAt: null,
				})),
			};
		}
		const entries = moduleMigrationStatus(database, module.migrations);
		const ledger = ledgerRows(database).length;
		database.close();
		for (const entry of entries) counters[entry.state] += 1;
		return {
			moduleId: module.moduleId,
			database: path,
			databaseExists: true,
			ledger,
			migrations: entries,
		};
	});
	const data = {
		modules: reports,
		unmanaged: modules.unmanaged,
		summary: counters,
	};
	return counters.mismatch > 0
		? failure(
				'MIGRATION_CHECKSUM_MISMATCH',
				`${counters.mismatch} applied migration(s) no longer match their recorded checksum.`,
				data,
			)
		: success(data, {
				evidence: reports.map((report) => report.database),
			});
}

export async function migrationApply(
	workspace: Workspace,
	moduleId: string,
	apply: boolean,
): Promise<CommandEnvelope> {
	const modules = await loadMigrationModules(workspace, moduleId);
	const refusal = moduleFilterFailure(modules, moduleId);
	if (refusal) return refusal;
	const module = modules.managed[0];
	if (!module) {
		return failure('MODULE_NOT_FOUND', `No enabled module "${moduleId}".`);
	}

	const path = displayPath(workspace.root, module.databasePath);
	let database: DatabaseSync;
	try {
		/* A dry run opens read-only so it cannot even create the file. */
		database = open(module.databasePath, !apply);
	} catch (error) {
		if (apply) {
			return failure(
				'DATABASE_UNAVAILABLE',
				`Cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return success(
			{
				moduleId: module.moduleId,
				database: path,
				applied: false,
				migrations: module.migrations.map((migration) => ({
					id: migration.id,
					action: 'applied' as const,
					checksum: moduleMigrationChecksum(migration.statements),
				})),
			},
			{
				warnings: [
					'Dry run only. Pass --apply to write the ledger and run the SQL.',
					`${path} does not exist yet; the module creates it on first use.`,
				],
			},
		);
	}
	try {
		const results = runModuleMigrations(database, module.migrations, {
			dryRun: !apply,
		});
		return success(
			{
				moduleId: module.moduleId,
				database: path,
				applied: apply,
				migrations: results,
			},
			{
				evidence: [path],
				warnings: apply
					? []
					: ['Dry run only. Pass --apply to write the ledger and run the SQL.'],
			},
		);
	} catch (error) {
		return failure(
			'MIGRATION_FAILED',
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		database.close();
	}
}

export async function migrationVerify(
	workspace: Workspace,
): Promise<CommandEnvelope> {
	const modules = await loadMigrationModules(workspace);
	const reports = modules.managed.map((module) => {
		const expected = new Map(
			module.migrations.map((migration) => [
				migration.id,
				moduleMigrationChecksum(migration.statements),
			]),
		);
		let rows: readonly LedgerRow[];
		try {
			const database = open(module.databasePath, true);
			rows = ledgerRows(database);
			database.close();
		} catch {
			return {
				moduleId: module.moduleId,
				database: displayPath(workspace.root, module.databasePath),
				recorded: 0,
				mismatched: [] as string[],
				unknown: [] as string[],
			};
		}
		return {
			moduleId: module.moduleId,
			database: displayPath(workspace.root, module.databasePath),
			recorded: rows.length,
			mismatched: rows
				.filter(
					(row) =>
						expected.has(row.id) && expected.get(row.id) !== row.checksum,
				)
				.map((row) => row.id),
			unknown: rows.filter((row) => !expected.has(row.id)).map((row) => row.id),
		};
	});
	const broken = reports.filter(
		(report) => report.mismatched.length > 0 || report.unknown.length > 0,
	);
	const data = { modules: reports, unmanaged: modules.unmanaged };
	return broken.length === 0
		? success(
				{ valid: true, ...data },
				{ evidence: reports.map((report) => report.database) },
			)
		: failure(
				'MIGRATION_LEDGER_INVALID',
				`${broken.length} module ledger(s) disagree with the migrations in the workspace.`,
				data,
			);
}
