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
import { createDocumentRenderRunner } from '../services/template-runner.ts';
import {
	DatabaseTemplatesRepository,
	type DocumentTemplatesRepository,
} from '../services/templates-repository.ts';
import {
	DocumentTemplateRegistry,
	DocumentTemplatesService,
} from '../services/templates-service.ts';
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
	/** The workspace IANA zone rendered dates are shown in, read live. */
	readonly timeZone?: (tenantId: string) => string | Promise<string>;
	/** Test seam: an already migrated repository, so no lease is taken. */
	readonly repository?: DocumentsRepository;
	/** Test seam, used together with `repository`. */
	readonly templatesRepository?: DocumentTemplatesRepository;
	readonly textPollIntervalMs?: number;
	readonly renderPollIntervalMs?: number;
	readonly textLimits?: Partial<DocumentTextLimits>;
}

export interface DocumentsRuntime {
	service(): Promise<DocumentsService>;
	textService(): Promise<DocumentTextService>;
	/** The template catalogue modules register into while the platform composes. */
	readonly templates: DocumentTemplateRegistry;
	templatesService(): Promise<DocumentTemplatesService>;
	templatesRepository(): Promise<DocumentTemplatesRepository>;
	/** One text runner pass, for a test that must not wait on a timer. */
	tickText(): Promise<void>;
	/** One render runner pass. */
	tickRender(): Promise<void>;
	start(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createDocumentsRuntime(
	options: DocumentsRuntimeOptions,
): DocumentsRuntime {
	let disposed = false;
	let leases: Promise<DatabaseAdapterLease>[] = [];
	let repositoryPromise:
		| Promise<{
				readonly documents: DocumentsRepository;
				readonly templates: DocumentTemplatesRepository | null;
		  }>
		| undefined;
	let servicePromise: Promise<DocumentsService> | undefined;
	let textServicePromise: Promise<DocumentTextService> | undefined;
	let templatesServicePromise: Promise<DocumentTemplatesService> | undefined;
	const registry = new DocumentTemplateRegistry();

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async () => {
		if (options.repository) {
			return {
				documents: options.repository,
				templates: options.templatesRepository ?? null,
			};
		}
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
		return {
			documents: new DatabaseDocumentsRepository(
				runtime.database,
				background.database,
			),
			templates: new DatabaseTemplatesRepository(
				runtime.database,
				background.database,
			),
		};
	};

	const repositories = () => {
		if (disposed) {
			return Promise.reject(new Error('Documents runtime is disposed.'));
		}
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};
	const repository = async (): Promise<DocumentsRepository> =>
		(await repositories()).documents;

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

	const templatesService = (): Promise<DocumentTemplatesService> => {
		if (disposed) {
			return Promise.reject(new Error('Documents runtime is disposed.'));
		}
		templatesServicePromise ??= repositories().then((resolved) => {
			if (!resolved.templates) {
				throw new Error('This documents runtime has no templates repository.');
			}
			return new DocumentTemplatesService({
				registry,
				repository: resolved.templates,
				documents: resolved.documents,
				storage: options.storage,
				quotaBytes: options.quotaBytes,
				timeZone: options.timeZone ?? (() => 'UTC'),
				wake: () => render.wake(),
			});
		});
		return templatesServicePromise;
	};

	const templatesRepository =
		async (): Promise<DocumentTemplatesRepository> => {
			const resolved = (await repositories()).templates;
			if (!resolved)
				throw new Error('This documents runtime has no templates repository.');
			return resolved;
		};

	const render = createDocumentRenderRunner({
		repository: templatesRepository,
		service: templatesService,
		pollIntervalMs: options.renderPollIntervalMs,
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
		templates: registry,
		templatesService,
		templatesRepository,
		async tickText() {
			await text.tick();
		},
		async tickRender() {
			await render.tick();
		},
		start: () => {
			registry.seal();
			text.start();
			if (!options.repository || options.templatesRepository) render.start();
		},
		quiesce: async () => {
			await Promise.all([text.quiesce(), render.quiesce()]);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await Promise.all([text.dispose(), render.dispose()]);
			/* An open still in flight would assign its leases after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await repositoryPromise?.catch(() => undefined);
			repositoryPromise = undefined;
			servicePromise = undefined;
			textServicePromise = undefined;
			templatesServicePromise = undefined;
			const open = leases;
			leases = [];
			for (const lease of open) {
				await (await lease.catch(() => null))?.release();
			}
		},
	};
}
