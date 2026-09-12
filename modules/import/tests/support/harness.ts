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
import type { AuthPrincipal } from '@flowdular/module-auth';
import type { DocumentAttachments } from '@flowdular/module-documents';
import {
	createDocumentAttachments,
	DatabaseDocumentsRepository,
	DocumentsService,
	migrateDocumentsDatabase,
} from '@flowdular/module-documents/server';
import {
	createStorageKeyring,
	createStoragePort,
	storageConfigFromEnvironment,
	type StoragePort,
} from '@flowdular/storage';
import { IMPORT_PERMISSIONS } from '../../src/acl/permissions.ts';
import {
	DatabaseImportRepository,
	migrateImportDatabase,
} from '../../src/services/database-repository.ts';
import { createImportCsvSource } from '../../src/services/csv-source.ts';
import { ImportService } from '../../src/services/import-service.ts';
import { ImportRunner } from '../../src/services/import-runner.ts';
import {
	createImportPortRegistry,
	type ImportPortRegistry,
} from '../../src/services/port-registry.ts';
import { IMPORT_OWNER_MODULE } from '../../src/services/csv-source.ts';

export const IMPORT_TENANT_TABLES = [
	'import_jobs',
	'import_job_rows',
	'import_mappings',
] as const;

export const TENANT = 'tenant-import';
export const OTHER_TENANT = 'tenant-other';
export const TARGET_PERMISSION = 'users.members.manage';

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
} as const;

export interface ImportTestHarness {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseImportRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read handle held by the job poll. */
	readonly background: DatabaseHandle;
	readonly ports: ImportPortRegistry;
	readonly storage: StoragePort;
	readonly attachments: DocumentAttachments;
	readonly service: ImportService;
	readonly runner: ImportRunner;
	/** Stores a CSV the way the New import screen does, through documents.core. */
	storeCsv(
		tenantId: string,
		body: string,
		options?: { readonly contentType?: string; readonly documentRef?: string },
	): Promise<{ readonly documentId: string; readonly documentRef: string }>;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

export interface ImportHarnessOptions {
	readonly maxRows?: number;
	readonly batchSize?: number;
	readonly maxObjectBytes?: number;
}

/**
 * The real auth principal shape, the real documents module over the real
 * storage port in a temporary directory, and the real import schema on an
 * embedded PostgreSQL with forced row-level security. Only the import port is a
 * fake, because the module under test is the one between them.
 */
export async function openImportHarness(
	options: ImportHarnessOptions = {},
): Promise<ImportTestHarness> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-import-'));
	const environment = {
		NODE_ENV: 'test',
		FD_STORAGE_ADAPTER: 'local',
		FD_STORAGE_LOCAL_DIRECTORY: directory,
		FD_STORAGE_MAX_OBJECT_BYTES: String(options.maxObjectBytes ?? 1_048_576),
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
			namespace: 'import.core',
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
		await migrateImportDatabase(owner.database);
		await migrateDocumentsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'import.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'import.core',
			purpose: 'background',
			requirements: REQUIREMENTS,
		});
		leases.push(background);

		const documents = new DocumentsService({
			repository: new DatabaseDocumentsRepository(runtime.database),
			storage,
			quotaBytes: () => 64 * 1024 * 1024,
			readUrlSeconds: () => 300,
		});
		const attachments = createDocumentAttachments(async () => documents);
		const repository = new DatabaseImportRepository({
			runtime: runtime.database,
			background: background.database,
		});
		const ports = createImportPortRegistry();
		const service = new ImportService({
			repository,
			ports,
			source: createImportCsvSource({
				attachments: () => attachments,
			}),
			maxRows: () => options.maxRows ?? 50_000,
			batchSize: () => options.batchSize ?? 500,
		});
		const runner = new ImportRunner({
			repository,
			service: async () => service,
		});

		let uploads = 0;
		return {
			databases,
			repository,
			runtime: runtime.database,
			background: background.database,
			ports,
			storage,
			attachments,
			service,
			runner,
			async storeCsv(tenantId, body, storeOptions = {}) {
				uploads += 1;
				const documentRef = storeOptions.documentRef ?? `import-${uploads}`;
				const record = await documents.upload(tenantId, 'account-ada', {
					ownerModule: IMPORT_OWNER_MODULE,
					recordRef: documentRef,
					filename: `source-${uploads}.csv`,
					contentType: storeOptions.contentType ?? 'text/csv',
					body: new TextEncoder().encode(body),
				});
				return { documentId: record.id, documentRef };
			},
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${IMPORT_TENANT_TABLES.join(', ')}, documents_files`,
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

export function principal(
	scopes: readonly string[] = [
		IMPORT_PERMISSIONS.read,
		IMPORT_PERMISSIONS.manage,
		TARGET_PERMISSION,
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
