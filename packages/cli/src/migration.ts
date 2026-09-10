import { findModuleFiles } from './module-files.ts';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { importModuleSource } from './module-import.ts';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import type { ModuleManifest } from '@flowdular/contracts';
import {
	databaseMigrationStatus,
	databaseProviderConfigFromEnvironment,
	runDatabaseMigrations,
	type ConfiguredDatabaseProvider,
	type DatabaseMigration,
} from '@flowdular/database';
import { createCliDatabaseProvider } from './database.ts';
import { moduleMigrationAudit } from './migration-audit.ts';
import { findNamedFiles } from './validation.ts';
import type { Workspace } from './workspace.ts';

export interface MigrationModule {
	readonly moduleId: string;
	readonly moduleDirectory: string;
	readonly databaseMigrations: readonly DatabaseMigration[];
}

export interface UnmanagedModule {
	readonly moduleId: string;
	readonly reason: string;
}

export interface MigrationModules {
	readonly managed: readonly MigrationModule[];
	readonly unmanaged: readonly UnmanagedModule[];
}

export async function loadMigrationModules(
	workspace: Workspace,
	moduleId?: string,
): Promise<MigrationModules> {
	const enabled = new Set(
		(workspace.config.modules as { enabled?: string[] } | undefined)?.enabled ??
			[],
	);
	const manifests = await findModuleFiles(workspace);
	const managed: MigrationModule[] = [];
	const unmanaged: UnmanagedModule[] = [];
	for (const manifestPath of manifests) {
		const manifest = JSON.parse(
			await readFile(manifestPath, 'utf8'),
		) as ModuleManifest;
		if (!enabled.has(manifest.id)) continue;
		if (moduleId && manifest.id !== moduleId) continue;
		const entry = join(dirname(manifestPath), 'src/services/migration.ts');
		try {
			await stat(entry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		const { databaseMigrations } = (await importModuleSource(
			entry,
			dirname(manifestPath),
		)) as { databaseMigrations?: unknown };
		if (!Array.isArray(databaseMigrations)) {
			unmanaged.push({
				moduleId: manifest.id,
				reason:
					'src/services/migration.ts exports no "databaseMigrations" list, so the migration runner owns none of its schema.',
			});
			continue;
		}
		managed.push({
			moduleId: manifest.id,
			moduleDirectory: dirname(manifestPath),
			databaseMigrations: databaseMigrations as readonly DatabaseMigration[],
		});
	}
	return { managed, unmanaged };
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

/* Every module shares the one database the application opens, so its state is
   read through the configured provider exactly as the application reads it.
   One provider serves every module in the command. */
async function withProviderModules<T>(
	workspace: Workspace,
	modules: readonly MigrationModule[],
	run: (
		databases: ConfiguredDatabaseProvider,
		module: MigrationModule,
	) => Promise<T>,
): Promise<readonly T[]> {
	if (modules.length === 0) return [];
	const config = databaseProviderConfigFromEnvironment(
		process.env,
		workspace.root,
	);
	const databases = createCliDatabaseProvider(config);
	try {
		const results: T[] = [];
		for (const module of modules) results.push(await run(databases, module));
		return results;
	} finally {
		await databases.dispose();
	}
}

export async function migrationStatus(
	workspace: Workspace,
	moduleId?: string,
): Promise<CommandEnvelope> {
	const modules = await loadMigrationModules(workspace, moduleId);
	const refusal = moduleFilterFailure(modules, moduleId);
	if (refusal) return refusal;

	const counters = { applied: 0, adopted: 0, pending: 0, mismatch: 0 };
	const count = (state: string): void => {
		if (state in counters) {
			counters[state as keyof typeof counters] += 1;
		}
	};
	const reports = await withProviderModules(
		workspace,
		modules.managed,
		async (databases, module) => {
			const lease = await databases.acquire({
				namespace: module.moduleId,
				purpose: 'migration',
			});
			try {
				const entries = await databaseMigrationStatus(
					lease.database,
					module.moduleId,
					module.databaseMigrations,
				);
				for (const entry of entries) count(entry.state);
				return {
					moduleId: module.moduleId,
					database: `${databases.adapter}:${module.moduleId}`,
					ledger: entries.filter((entry) => entry.state !== 'pending').length,
					migrations: entries.map((entry) => ({
						id: entry.id,
						state: entry.state,
						checksum: entry.checksum,
						appliedAt: entry.appliedAt ?? null,
					})),
				};
			} finally {
				await lease.release();
			}
		},
	);
	const all = [...reports].sort((left, right) =>
		left.moduleId.localeCompare(right.moduleId),
	);
	const data = {
		modules: all,
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
				evidence: all.map((report) => report.database),
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

	/* The runner is transactional, so a dry run reports the plan without opening
	   a write path: status already answers what would run. */
	const [report] = await withProviderModules(
		workspace,
		[module],
		async (databases, entry) => {
			const lease = await databases.acquire({
				namespace: entry.moduleId,
				purpose: 'migration',
			});
			try {
				if (!apply) {
					const pending = await databaseMigrationStatus(
						lease.database,
						entry.moduleId,
						entry.databaseMigrations,
					);
					return {
						adapter: databases.adapter,
						migrations: pending
							.filter((state) => state.state !== 'applied')
							.map((state) => ({
								id: state.id,
								action: state.state === 'adopted' ? 'adopted' : 'applied',
								checksum: state.checksum,
							})),
					};
				}
				return {
					adapter: databases.adapter,
					migrations: await runDatabaseMigrations(
						lease.database,
						entry.moduleId,
						entry.databaseMigrations,
					),
				};
			} finally {
				await lease.release();
			}
		},
	);
	return success(
		{
			moduleId: module.moduleId,
			database: `${report!.adapter}:${module.moduleId}`,
			applied: apply,
			migrations: report!.migrations,
		},
		{
			warnings: apply
				? []
				: ['Dry run only. Pass --apply to write the ledger and run the SQL.'],
		},
	);
}

export async function migrationVerify(
	workspace: Workspace,
): Promise<CommandEnvelope> {
	const modules = await loadMigrationModules(workspace);
	const reports = await withProviderModules(
		workspace,
		modules.managed,
		async (databases, module) => {
			const lease = await databases.acquire({
				namespace: module.moduleId,
				purpose: 'migration',
			});
			try {
				const entries = await databaseMigrationStatus(
					lease.database,
					module.moduleId,
					module.databaseMigrations,
				);
				return {
					moduleId: module.moduleId,
					database: `${databases.adapter}:${module.moduleId}`,
					recorded: entries.filter((entry) => entry.state !== 'pending').length,
					mismatched: entries
						.filter((entry) => entry.state === 'mismatch')
						.map((entry) => entry.id),
					unknown: [] as string[],
				};
			} finally {
				await lease.release();
			}
		},
	);
	/* Checksum drift is one half of the contract; the other is that the committed
	   scripts still declare what a deployment needs. A missing tenant policy is a
	   deployment-time isolation failure, so it fails here instead. */
	const audits = await Promise.all(
		modules.managed.map((module) =>
			moduleMigrationAudit(
				module.moduleId,
				module.moduleDirectory,
				module.databaseMigrations,
			),
		),
	);
	const auditIssues = audits.flatMap((report) => report.issues);
	const all = [...reports].sort((left, right) =>
		left.moduleId.localeCompare(right.moduleId),
	);
	const broken = all.filter(
		(report) => report.mismatched.length > 0 || report.unknown.length > 0,
	);
	const data = {
		modules: all,
		unmanaged: modules.unmanaged,
		scripts: audits.map((report) => ({
			moduleId: report.moduleId,
			migrations: report.migrations,
			issues: report.issues,
		})),
	};
	if (auditIssues.length > 0) {
		return failure(
			'MIGRATION_SCRIPTS_INVALID',
			`${auditIssues.length} migration script issue(s): ${auditIssues
				.map(
					(issue) => `${issue.moduleId} ${issue.migrationId}: ${issue.message}`,
				)
				.join(' ')}`,
			data,
		);
	}
	return broken.length === 0
		? success(
				{ valid: true, ...data },
				{ evidence: all.map((report) => report.database) },
			)
		: failure(
				'MIGRATION_LEDGER_INVALID',
				`${broken.length} module ledger(s) disagree with the migrations in the workspace.`,
				data,
			);
}
