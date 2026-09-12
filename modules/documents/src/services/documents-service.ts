import { randomUUID } from 'node:crypto';
import type {
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import {
	StorageError,
	storageObjectKey,
	type StorageObjectRef,
	type StoragePort,
} from '@flowdular/storage';
import type {
	DocumentAttachment,
	DocumentAttachmentBody,
} from '../domain/attachments.ts';
import {
	DOCUMENT_LIMITS,
	type DocumentFilters,
	type DocumentReadUrl,
	type DocumentsFile,
	type UploadDocumentInput,
} from '../domain/types.ts';
import type { DocumentPageCursor, DocumentsRepository } from './repository.ts';

/** The storage module segment: the key is `<tenant>/documents.core/<id>`. */
export const DOCUMENTS_STORAGE_MODULE = 'documents.core';

export class DocumentsServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'DocumentsServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new DocumentsServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	/* A NUL ends a C string: a value carrying one reads differently in a log, a
	   filesystem and a header than it does in the row. */
	if (normalized.includes('\u0000')) {
		throw new DocumentsServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

/* The name is shown and offered as a download, never resolved as a path, but a
   separator in it would still let one workspace's file present itself as
   another's location to whatever opens it. */
function filename(value: string): string {
	const normalized = bounded(value, 'filename', 1, DOCUMENT_LIMITS.filename);
	if (/[/\\]/.test(normalized)) {
		throw new DocumentsServiceError(
			'INVALID_INPUT',
			'filename must not contain a path separator.',
		);
	}
	return normalized;
}

/** One page of a list: how many rows, and the keyset the last one ended on. */
export interface DocumentPage {
	readonly limit?: number | undefined;
	readonly after?: DocumentPageCursor | null | undefined;
}

export interface DocumentsServiceOptions {
	readonly repository: DocumentsRepository;
	readonly storage: StoragePort;
	/** Live tenant quota in bytes; read again for every upload. */
	readonly quotaBytes: (tenantId: string) => number;
	/** Live platform read URL lifetime in seconds. */
	readonly readUrlSeconds: () => number;
	readonly now?: () => number;
	readonly newId?: () => string;
}

export function documentAttachment(record: DocumentsFile): DocumentAttachment {
	return {
		id: record.id,
		ownerModule: record.ownerModule,
		recordRef: record.recordRef,
		filename: record.filename,
		contentType: record.contentType,
		bytes: record.bytes,
		checksum: record.checksum,
		scan: record.scan,
		status: record.status,
		uploaderAccountId: record.uploaderAccountId,
		description: record.description,
		createdAt: record.createdAt,
	};
}

export class DocumentsService {
	private readonly repository: DocumentsRepository;
	private readonly storage: StoragePort;
	private readonly quotaBytes: (tenantId: string) => number;
	private readonly readUrlSeconds: () => number;
	private readonly now: () => number;
	private readonly newId: () => string;

	constructor(options: DocumentsServiceOptions) {
		this.repository = options.repository;
		this.storage = options.storage;
		this.quotaBytes = options.quotaBytes;
		this.readUrlSeconds = options.readUrlSeconds;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
	}

	/**
	 * One page of the workspace's documents, newest first. The filters and the
	 * page are the server's: a screen that narrowed its own page would be
	 * narrowing whatever fifty rows it happened to hold.
	 */
	list(
		tenantId: string,
		filters: DocumentFilters = {},
		page: DocumentPage = {},
	): Promise<readonly DocumentsFile[]> {
		return this.repository.list(
			this.tenant(tenantId),
			{
				...(filters.ownerModule === undefined
					? {}
					: {
							ownerModule: bounded(
								filters.ownerModule,
								'ownerModule',
								1,
								DOCUMENT_LIMITS.ownerModule,
							),
						}),
				...(filters.recordRef === undefined
					? {}
					: {
							recordRef: bounded(
								filters.recordRef,
								'recordRef',
								1,
								DOCUMENT_LIMITS.recordRef,
							),
						}),
				...(filters.scan === undefined ? {} : { scan: filters.scan }),
				...(filters.search === undefined
					? {}
					: {
							search: bounded(
								filters.search,
								'search',
								1,
								DOCUMENT_LIMITS.search,
							),
						}),
			},
			Math.min(
				Math.max(Math.trunc(page.limit ?? DOCUMENT_LIMITS.page), 1),
				DOCUMENT_LIMITS.page,
			),
			page.after ?? null,
		);
	}

	listAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
	): Promise<readonly DocumentsFile[]> {
		return this.repository.list(
			this.tenant(tenantId),
			{
				ownerModule: bounded(
					ownerModule,
					'ownerModule',
					1,
					DOCUMENT_LIMITS.ownerModule,
				),
				recordRef: bounded(
					recordRef,
					'recordRef',
					1,
					DOCUMENT_LIMITS.recordRef,
				),
			},
			DOCUMENT_LIMITS.page,
		);
	}

	/**
	 * One request, one object. The quota is checked before a byte is stored, the
	 * port applies the size, type, magic byte and scanner rules, and the metadata
	 * row is written only once the object is in the store: a refusal leaves no
	 * row and no object, and an infected upload leaves the trail row alone.
	 */
	async upload(
		tenantId: string,
		uploaderAccountId: string,
		input: UploadDocumentInput,
	): Promise<DocumentsFile> {
		const tenant = this.tenant(tenantId);
		const record = {
			ownerModule: bounded(
				input.ownerModule,
				'ownerModule',
				1,
				DOCUMENT_LIMITS.ownerModule,
			),
			recordRef: bounded(
				input.recordRef,
				'recordRef',
				1,
				DOCUMENT_LIMITS.recordRef,
			),
			filename: filename(input.filename),
			/* Bounded before the port sees it, so the trail row of an infected
			   upload is written from a value that already passed validation. */
			contentType: bounded(
				input.contentType,
				'contentType',
				1,
				DOCUMENT_LIMITS.contentType,
			),
			uploaderAccountId: bounded(
				uploaderAccountId,
				'uploaderAccountId',
				1,
				DOCUMENT_LIMITS.accountId,
			),
			description:
				input.description === undefined || input.description === null
					? null
					: bounded(
							input.description,
							'description',
							1,
							DOCUMENT_LIMITS.description,
						),
		};
		const remaining = await this.remainingBytes(tenant);
		if (
			remaining <= 0 ||
			(input.declaredBytes !== undefined && input.declaredBytes > remaining)
		) {
			throw quotaExceeded(remaining);
		}

		const reference: StorageObjectRef = {
			tenantId: tenant,
			moduleId: DOCUMENTS_STORAGE_MODULE,
			objectId: this.newId(),
		};
		const storageKey = storageObjectKey(reference);
		const object = await this.store(
			reference,
			input.body,
			input.declaredBytes,
			{ ...record, storageKey, tenantId: tenant },
		);

		/* `content-length` is the client's claim, so the quota is measured again
		   against what the port actually read. Two uploads racing here can still
		   overshoot by one object each; the precise fix is a per-tenant usage row
		   updated in the transaction that writes the metadata. */
		if (object.bytes > remaining) {
			await this.storage.delete(reference);
			throw quotaExceeded(remaining);
		}

		const stored: DocumentsFile = {
			...record,
			id: reference.objectId,
			tenantId: tenant,
			contentType: object.contentType,
			bytes: object.bytes,
			checksum: object.checksum,
			storageKey,
			scan: object.scan,
			status: 'stored',
			createdAt: this.now(),
		};
		try {
			return await this.repository.create(stored);
		} catch (error) {
			/* The object outlives the row otherwise: nothing would ever name it
			   again, and it would still count against the workspace's bytes. */
			await this.storage.delete(reference);
			throw error;
		}
	}

	/**
	 * Writes every row of one workspace into the sink, oldest first, in bounded
	 * pages so an export never holds a workspace in memory. Deleted rows are
	 * part of it: they are the trail of what the workspace once held. The bytes
	 * stay in the store, and the row names the object that carries them.
	 */
	async exportTo(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		const tenant = this.tenant(tenantId);
		let cursor: DocumentPageCursor | null = null;
		let rows = 0;
		let from: Date | null = null;
		let to: Date | null = null;
		for (;;) {
			const page = await this.repository.listForExport(
				tenant,
				cursor,
				DOCUMENT_LIMITS.page,
			);
			for (const record of page) {
				await sink.write({
					id: record.id,
					ownerModule: record.ownerModule,
					recordRef: record.recordRef,
					filename: record.filename,
					contentType: record.contentType,
					bytes: record.bytes,
					checksum: record.checksum,
					storageKey: record.storageKey,
					uploaderAccountId: record.uploaderAccountId,
					scan: record.scan,
					status: record.status,
					description: record.description,
					createdAt: new Date(record.createdAt).toISOString(),
				});
				rows += 1;
				from ??= new Date(record.createdAt);
				to = new Date(record.createdAt);
			}
			if (page.length < DOCUMENT_LIMITS.page) break;
			const last = page[page.length - 1]!;
			cursor = { createdAt: last.createdAt, id: last.id };
		}
		return { rows, from, to };
	}

	async readUrl(tenantId: string, id: string): Promise<DocumentReadUrl> {
		const tenant = this.tenant(tenantId);
		const record = await this.require(tenant, id);
		if (record.scan === 'infected') {
			throw new DocumentsServiceError(
				'DOCUMENT_INFECTED',
				'An infected document is never downloadable.',
				409,
			);
		}
		if (record.status === 'deleted') {
			throw new DocumentsServiceError(
				'DOCUMENT_DELETED',
				'The document was deleted.',
				409,
			);
		}
		const expiresInSeconds = this.readUrlSeconds();
		return {
			url: await this.storage.readUrl({
				...this.referenceOf(record),
				expiresInSeconds,
			}),
			expiresInSeconds,
		};
	}

	/** The object first, the row after, so no row ever outlives its bytes. */
	async remove(tenantId: string, id: string): Promise<DocumentsFile> {
		const tenant = this.tenant(tenantId);
		const record = await this.require(tenant, id);
		if (record.status === 'deleted') return record;
		await this.storage.delete(this.referenceOf(record));
		/* A null means another request deleted the row between the read and the
		   update; the object is gone either way, so the answer is the same. */
		return (
			(await this.repository.markDeleted(tenant, id)) ?? {
				...record,
				status: 'deleted',
			}
		);
	}

	/**
	 * The bytes behind one attachment reference, read through the same storage
	 * access the read URL route streams from. Null rather than a throw for every
	 * reference with nothing readable behind it, infected and deleted included,
	 * so a module can never reach bytes the download route refuses.
	 */
	async openAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<DocumentAttachmentBody | null> {
		const tenant = this.tenant(tenantId);
		const record = await this.repository.findAttached(
			tenant,
			bounded(ownerModule, 'ownerModule', 1, DOCUMENT_LIMITS.ownerModule),
			bounded(recordRef, 'recordRef', 1, DOCUMENT_LIMITS.recordRef),
			bounded(id, 'id', 1, DOCUMENT_LIMITS.id),
		);
		if (!record || record.status === 'deleted' || record.scan === 'infected') {
			return null;
		}
		const read = await this.storage.get(this.referenceOf(record));
		if (!read) return null;
		return {
			contentType: record.contentType,
			bytes: record.bytes,
			filename: record.filename,
			body: read.body,
		};
	}

	async removeAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<boolean> {
		const tenant = this.tenant(tenantId);
		const record = await this.repository.findAttached(
			tenant,
			bounded(ownerModule, 'ownerModule', 1, DOCUMENT_LIMITS.ownerModule),
			bounded(recordRef, 'recordRef', 1, DOCUMENT_LIMITS.recordRef),
			bounded(id, 'id', 1, DOCUMENT_LIMITS.id),
		);
		if (!record || record.status === 'deleted') return false;
		await this.storage.delete(this.referenceOf(record));
		return (await this.repository.markDeleted(tenant, id)) !== null;
	}

	private async remainingBytes(tenantId: string): Promise<number> {
		const quota = this.quotaBytes(tenantId);
		return quota - (await this.repository.storedBytes(tenantId));
	}

	/**
	 * Hands the body to the port and turns its refusals into stable codes. An
	 * infected verdict is the one refusal that keeps a row: the object is deleted
	 * first, so the trail can never point at readable bytes.
	 */
	private async store(
		reference: StorageObjectRef,
		body: UploadDocumentInput['body'],
		declaredBytes: number | undefined,
		trail: Omit<
			DocumentsFile,
			'id' | 'bytes' | 'checksum' | 'createdAt' | 'scan' | 'status'
		>,
	) {
		try {
			return await this.storage.put({
				...reference,
				contentType: trail.contentType,
				body,
				declaredBytes,
			});
		} catch (error) {
			if (!(error instanceof StorageError)) throw error;
			if (error.code === 'OBJECT_INFECTED') {
				await this.storage.delete(reference);
				await this.repository.create({
					...trail,
					id: reference.objectId,
					bytes: 0,
					checksum: null,
					scan: 'infected',
					status: 'deleted',
					createdAt: this.now(),
				});
			}
			throw refusal(error);
		}
	}

	private referenceOf(record: DocumentsFile): StorageObjectRef {
		return {
			tenantId: record.tenantId,
			moduleId: DOCUMENTS_STORAGE_MODULE,
			objectId: record.id,
		};
	}

	private async require(tenantId: string, id: string): Promise<DocumentsFile> {
		const record = await this.repository.find(
			tenantId,
			bounded(id, 'id', 1, DOCUMENT_LIMITS.id),
		);
		if (!record) {
			throw new DocumentsServiceError(
				'DOCUMENT_NOT_FOUND',
				'The document does not exist in this workspace.',
				404,
			);
		}
		return record;
	}

	private tenant(tenantId: string): string {
		return bounded(tenantId, 'tenantId', 1, DOCUMENT_LIMITS.accountId);
	}
}

function quotaExceeded(remaining: number): DocumentsServiceError {
	return new DocumentsServiceError(
		'QUOTA_EXCEEDED',
		`The workspace storage quota leaves ${Math.max(remaining, 0)} bytes.`,
		413,
	);
}

/* The port's vocabulary, mapped once. A code it may add later is an internal
   failure here rather than a refusal the caller can act on. */
function refusal(error: StorageError): DocumentsServiceError {
	switch (error.code) {
		case 'OBJECT_TOO_LARGE':
			return new DocumentsServiceError(
				'DOCUMENT_TOO_LARGE',
				error.message,
				413,
			);
		case 'CONTENT_TYPE_REFUSED':
			return new DocumentsServiceError(
				'CONTENT_TYPE_REFUSED',
				error.message,
				415,
			);
		case 'CONTENT_MISMATCH':
			return new DocumentsServiceError('CONTENT_MISMATCH', error.message, 400);
		case 'OBJECT_INFECTED':
			return new DocumentsServiceError('DOCUMENT_INFECTED', error.message, 422);
		case 'OBJECT_REFERENCE_INVALID':
		case 'EXPIRY_INVALID':
			return new DocumentsServiceError('INVALID_INPUT', error.message, 400);
		default:
			return new DocumentsServiceError(
				'STORAGE_UNAVAILABLE',
				'Document storage is unavailable.',
				503,
			);
	}
}
