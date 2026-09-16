import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { StoragePort } from '@flowdular/storage';
import { DocumentsService } from '../services/documents-service.ts';
import {
	DatabaseDocumentsRepository,
	migrateDocumentsDatabase,
} from '../services/database-repository.ts';
import type { DocumentsRepository } from '../services/repository.ts';
import type { DocumentTextLimits } from '../services/text/extract.ts';
import type { DocumentOcr } from '../services/text/ocr.ts';
import { createDocumentTextRunner } from '../services/text-runner.ts';
import { DocumentTextService } from '../services/text-service.ts';

export interface DocumentsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Platform-owned object storage; the module never sees an adapter. */
	readonly storage: StoragePort;
	/** Live tenant quota in bytes, read again for every upload. */
	readonly quotaBytes: (tenantId: string) => number | Promise<number>;
	/** Live platform read URL lifetime in seconds. */
	readonly readUrlSeconds: () => number;
	/** The deployment's OCR seam; null or absent when none is configured. */
	readonly ocr?: DocumentOcr | null;
	/** Test seam: an already migrated repository, so no lease is taken. */
	readonly repository?: DocumentsRepository;
	readonly textPollIntervalMs?: number;
	readonly textLimits?: Partial<DocumentTextLimits>;
}

export interface DocumentsRuntime {
	service(): Promise<DocumentsService>;
	textService(): Promise<DocumentTextService>;
	/** One text runner pass, for a test that must not wait on a timer. */
	tickText(): Promise<void>;
	start(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createDocumentsRuntime(
	options: DocumentsRuntimeOptions,
): DocumentsRuntime {
	let disposed = false;
	let leases: Promise<DatabaseAdapterLease>[] = [];
	let repositoryPromise: Promise<DocumentsRepository> | undefined;
	let servicePromise: Promise<DocumentsService> | undefined;
	let textServicePromise: Promise<DocumentTextService> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<DocumentsRepository> => {
		if (options.repository) return options.repository;
		const migrationLease = await options.databases.acquire({
			namespace: 'documents.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migrateDocumentsDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		const acquire = (purpose: DatabaseProviderRequest['purpose']) => {
			const lease = options.databases.acquire({
				namespace: 'documents.core',
				purpose,
				requirements: {
					dialectIds: [DATABASE_DIALECT_IDS.postgresql],
					capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
				},
			});
			leases.push(lease);
			return lease;
		};
		const runtime = await acquire(options.purpose);
		/* The text runner's routing read crosses workspaces; every claim and
		   write that follows runs under the workspace the routing row named. */
		const background = await acquire('background');
		return new DatabaseDocumentsRepository(
			runtime.database,
			background.database,
		);
	};

	const repository = (): Promise<DocumentsRepository> => {
		if (disposed) {
			return Promise.reject(new Error('Documents runtime is disposed.'));
		}
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};

	const textService = (): Promise<DocumentTextService> => {
		if (disposed) {
			return Promise.reject(new Error('Documents runtime is disposed.'));
		}
		textServicePromise ??= repository().then(
			(resolved) =>
				new DocumentTextService({
					repository: resolved,
					storage: options.storage,
					ocr: options.ocr ?? null,
					wake: () => text.wake(),
					limits: options.textLimits,
				}),
		);
		return textServicePromise;
	};

	const text = createDocumentTextRunner({
		repository,
		service: textService,
		pollIntervalMs: options.textPollIntervalMs,
	});

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Documents runtime is disposed.'));
			}
			servicePromise ??= repository().then(
				(resolved) =>
					new DocumentsService({
						repository: resolved,
						storage: options.storage,
						quotaBytes: options.quotaBytes,
						readUrlSeconds: options.readUrlSeconds,
					}),
			);
			return servicePromise;
		},
		textService,
		async tickText() {
			await text.tick();
		},
		start: () => text.start(),
		quiesce: () => text.quiesce(),
		async dispose() {
			if (disposed) return;
			disposed = true;
			await text.dispose();
			/* An open still in flight would assign its leases after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await repositoryPromise?.catch(() => undefined);
			repositoryPromise = undefined;
			servicePromise = undefined;
			textServicePromise = undefined;
			const open = leases;
			leases = [];
			for (const lease of open) {
				await (await lease.catch(() => null))?.release();
			}
		},
	};
}
