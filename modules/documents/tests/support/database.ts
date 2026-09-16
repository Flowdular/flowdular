import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseDocumentsRepository,
	migrateDocumentsDatabase,
} from '../../src/services/database-repository.ts';
import {
	DocumentsService,
	type DocumentsServiceOptions,
} from '../../src/services/documents-service.ts';
import { DatabaseTemplatesRepository } from '../../src/services/templates-repository.ts';
import {
	DocumentTemplatesService,
	type DocumentTemplateRegistry,
	type DocumentTemplatesServiceOptions,
} from '../../src/services/templates-service.ts';
import {
	DocumentTextService,
	type DocumentTextServiceOptions,
} from '../../src/services/text-service.ts';
import {
	openTestStorage,
	type TestStorage,
	type TestStorageOptions,
} from './storage.ts';

export const DOCUMENTS_TENANT_TABLES = [
	'documents_files',
	'documents_text',
	'document_templates',
	'document_template_versions',
	'document_renders',
	'document_render_keys',
] as const;

export interface DocumentsTestContext {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseDocumentsRepository;
	readonly templates: DatabaseTemplatesRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** The cross-tenant role the text runner routes with. */
	readonly background: DatabaseHandle;
	readonly storage: TestStorage;
	/** A service over the same repository and port, with the seams a case needs. */
	service(
		options?: Partial<
			Pick<
				DocumentsServiceOptions,
				'quotaBytes' | 'readUrlSeconds' | 'now' | 'newId'
			>
		>,
	): DocumentsService;
	/** A templates service over the same repositories and port. */
	templatesService(
		registry: DocumentTemplateRegistry,
		options?: Partial<
			Omit<
				DocumentTemplatesServiceOptions,
				'registry' | 'repository' | 'documents' | 'storage'
			>
		>,
	): DocumentTemplatesService;
	/** A text service over the same repository and port. */
	textService(
		options?: Partial<
			Omit<DocumentTextServiceOptions, 'repository' | 'storage'>
		>,
	): DocumentTextService;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
} as const;

/**
 * An embedded PostgreSQL, or the cluster FD_TEST_DATABASE_ADAPTER names, with
 * the real runtime role and forced row-level security, plus the real storage
 * port over a temporary directory. Starting the engine costs seconds, so open
 * one per file and `reset()` between cases.
 */
export async function openDocumentsTestContext(
	storageOptions: TestStorageOptions = {},
): Promise<DocumentsTestContext> {
	const storage = await openTestStorage(storageOptions);
	const databases: DatabaseProvider = createTestDatabaseProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'documents.core',
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
		await migrateDocumentsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'documents.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'documents.core',
			purpose: 'background',
		});
		leases.push(background);
		const repository = new DatabaseDocumentsRepository(
			runtime.database,
			background.database,
		);
		const templates = new DatabaseTemplatesRepository(
			runtime.database,
			background.database,
		);
		return {
			databases,
			repository,
			templates,
			runtime: runtime.database,
			background: background.database,
			storage,
			service(options = {}) {
				return new DocumentsService({
					repository,
					storage: storage.port,
					quotaBytes: options.quotaBytes ?? (() => 10 * 1024 * 1024),
					readUrlSeconds: options.readUrlSeconds ?? (() => 300),
					...(options.now ? { now: options.now } : {}),
					...(options.newId ? { newId: options.newId } : {}),
				});
			},
			templatesService(registry, options = {}) {
				return new DocumentTemplatesService({
					registry,
					repository: templates,
					documents: repository,
					storage: storage.port,
					quotaBytes: options.quotaBytes ?? (() => 10 * 1024 * 1024),
					timeZone: options.timeZone ?? (() => 'Europe/Warsaw'),
					wake: options.wake ?? (() => undefined),
					...(options.renderers ? { renderers: options.renderers } : {}),
					...(options.now ? { now: options.now } : {}),
					...(options.newId ? { newId: options.newId } : {}),
				});
			},
			textService(options = {}) {
				return new DocumentTextService({
					repository,
					storage: storage.port,
					ocr: options.ocr ?? null,
					wake: options.wake ?? (() => undefined),
					...(options.now ? { now: options.now } : {}),
					...(options.limits ? { limits: options.limits } : {}),
				});
			},
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${DOCUMENTS_TENANT_TABLES.join(', ')}`,
						}),
					{ access: 'write' },
				);
				/* The rows and the objects are two stores; a case that asserts one is
				   absent has to start with both empty. */
				await storage.clear();
			},
			async dispose() {
				for (const lease of leases.reverse()) await lease.release();
				await databases.dispose();
				await storage.dispose();
			},
		};
	} catch (error) {
		for (const lease of leases.reverse()) await lease.release();
		await databases.dispose();
		await storage.dispose();
		throw error;
	}
}
