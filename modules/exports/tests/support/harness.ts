import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { JobRunner } from '@flowdular/server';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createStorageKeyring,
	createStoragePort,
	storageConfigFromEnvironment,
	type StoragePort,
} from '@flowdular/storage';
import { EXPORTS_PERMISSIONS } from '../../src/acl/permissions.ts';
import {
	DatabaseExportRepository,
	migrateExportsDatabase,
} from '../../src/services/database-repository.ts';
import { ExportService } from '../../src/services/export-service.ts';
import { createExportJobRunner } from '../../src/services/export-runner.ts';
import {
	createExportListRegistry,
	type ExportListRegistry,
} from '../../src/services/list-registry.ts';
import type { ExportRepository } from '../../src/services/repository.ts';

export const EXPORTS_TENANT_TABLES = ['exports_jobs'] as const;

export const TENANT = 'tenant-exports';
export const OTHER_TENANT = 'tenant-other';
export const LIST_PERMISSION = 'users.members.read';

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
} as const;

export interface ExportTestHarness {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseExportRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read handle held by the job poll. */
	readonly background: DatabaseHandle;
	readonly lists: ExportListRegistry;
	readonly storage: StoragePort;
	readonly service: ExportService;
	readonly runner: JobRunner;
	/** Object keys the store holds, workspace prefix first. */
	storedKeys(): Promise<readonly string[]>;
	/** The stored file of a completed job, decoded as text. */
	storedText(tenantId: string, objectId: string): Promise<string>;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

export interface ExportHarnessOptions {
	readonly maxRows?: number;
	readonly maxBytes?: number;
	readonly maxObjectBytes?: number;
	readonly claimTimeoutMs?: number;
}

/**
 * The real auth principal shape, the real storage port in a temporary
 * directory, and the real export schema on an embedded PostgreSQL with forced
 * row-level security. Only the exported list is a fake, because the module
 * under test is the one between them.
 */
export async function openExportHarness(
	options: ExportHarnessOptions = {},
): Promise<ExportTestHarness> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-exports-'));
	const maxObjectBytes = options.maxObjectBytes ?? 1_048_576;
	const environment = {
		NODE_ENV: 'test',
		FD_STORAGE_ADAPTER: 'local',
		FD_STORAGE_LOCAL_DIRECTORY: directory,
		FD_STORAGE_MAX_OBJECT_BYTES: String(maxObjectBytes),
	};
	const storage = createStoragePort(
		storageConfigFromEnvironment(environment, directory),
		{ keyring: createStorageKeyring(environment, directory) },
	);
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'exports.core',
			purpose: 'migration',
			requirements: {
				dialectIds: REQUIREMENTS.dialectIds,
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		leases.push(owner);
		await migrateExportsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'exports.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'exports.core',
			purpose: 'background',
			requirements: REQUIREMENTS,
		});
		leases.push(background);

		const repository = new DatabaseExportRepository({
			runtime: runtime.database,
			background: background.database,
		});
		const lists = createExportListRegistry();
		const service = new ExportService({
			repository,
			lists,
			storage,
			maxRows: () => options.maxRows ?? 100_000,
			maxBytes: () => options.maxBytes ?? 50 * 1024 * 1024,
			/* The same number the storage port above was configured with, the way
			   the composition reads it from the environment it built the port from. */
			maxObjectBytes: () => maxObjectBytes,
		});
		const runner = createExportJobRunner({
			repository: async () => repository,
			service: async () => service,
			...(options.claimTimeoutMs === undefined
				? {}
				: { claimTimeoutMs: options.claimTimeoutMs }),
		});

		return {
			databases,
			repository,
			runtime: runtime.database,
			background: background.database,
			lists,
			storage,
			service,
			runner,
			async storedKeys() {
				const { readdir } = await import('node:fs/promises');
				const found = await readdir(directory, {
					recursive: true,
					withFileTypes: true,
				});
				return found
					.filter((entry) => entry.isFile())
					.map((entry) =>
						join(entry.parentPath ?? directory, entry.name).slice(
							directory.length + 1,
						),
					)
					.sort();
			},
			async storedText(tenantId, objectId) {
				const read = await storage.get({
					tenantId,
					moduleId: 'exports.core',
					objectId,
				});
				if (!read) throw new Error(`No object ${objectId} is stored.`);
				const chunks: Uint8Array[] = [];
				const reader = read.body.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) chunks.push(value);
				}
				return Buffer.concat(chunks).toString('utf8');
			},
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${EXPORTS_TENANT_TABLES.join(', ')}`,
						}),
					{ access: 'write' },
				);
				await rm(directory, { recursive: true, force: true });
			},
			async dispose() {
				for (const lease of leases.reverse()) await lease.release();
				await databases.dispose();
				await storage.dispose();
				await rm(directory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		for (const lease of leases.reverse()) await lease.release();
		await databases.dispose();
		await storage.dispose();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The real repository with one or two methods answered differently, so a case
 * can put a failure exactly where it wants one and every other statement still
 * runs against the database. The class is delegated to by name rather than
 * spread, because its methods live on the prototype.
 */
export function repositoryWith(
	base: ExportRepository,
	overrides: Partial<ExportRepository>,
): ExportRepository {
	return {
		createJob: (job) => base.createJob(job),
		findJob: (tenantId, id) => base.findJob(tenantId, id),
		listJobs: (tenantId, query) => base.listJobs(tenantId, query),
		listPendingJobs: (limit) => base.listPendingJobs(limit),
		claimJob: (input) => base.claimJob(input),
		heartbeatJob: (tenantId, id, at, claimedAt) =>
			base.heartbeatJob(tenantId, id, at, claimedAt),
		settleJob: (tenantId, id, input) => base.settleJob(tenantId, id, input),
		claimSweepBatch: (tenantId, input) => base.claimSweepBatch(tenantId, input),
		deleteJobs: (tenantId, ids) => base.deleteJobs(tenantId, ids),
		exportJobs: (tenantId, sink) => base.exportJobs(tenantId, sink),
		...overrides,
	};
}

export function principal(
	scopes: readonly string[] = [
		EXPORTS_PERMISSIONS.read,
		EXPORTS_PERMISSIONS.manage,
		LIST_PERMISSION,
	],
	tenantId = TENANT,
	accountId = 'account-ada',
): AuthPrincipal {
	return {
		accountId,
		tenantId,
		email: `${accountId}@example.com`,
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}
