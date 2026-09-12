import type {
	DocumentAttachment,
	DocumentAttachments,
} from '@flowdular/module-documents';
import {
	IMPORT_CSV_CONTENT_TYPE,
	IMPORT_MAX_CSV_BYTES,
} from '../domain/types.ts';

/** The owner module every import source CSV is uploaded against. */
export const IMPORT_OWNER_MODULE = 'import.core';

export class ImportSourceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ImportSourceError';
	}
}

export interface ImportCsvSource {
	/** The stored CSV's metadata, or null when the reference matches nothing. */
	describe(
		tenantId: string,
		documentRef: string,
		documentId: string,
	): Promise<DocumentAttachment | null>;
	/** The decrypted CSV body, refused unless it is a CSV within the bound. */
	open(
		tenantId: string,
		documentRef: string,
		documentId: string,
	): Promise<ReadableStream<Uint8Array>>;
}

export interface ImportCsvSourceOptions {
	readonly attachments: () => DocumentAttachments | null;
}

/**
 * The CSV read path. Both calls go to `documents.attachments.v1` under this
 * module's own reference pair, so the ownership check is documents.core's and
 * import.core never addresses the object store.
 */
export function createImportCsvSource(
	options: ImportCsvSourceOptions,
): ImportCsvSource {
	const require = (): DocumentAttachments => {
		const attachments = options.attachments();
		if (!attachments) {
			throw new ImportSourceError(
				'DOCUMENTS_UNAVAILABLE',
				'The documents module is not available to read the source file.',
				503,
			);
		}
		return attachments;
	};

	const describe = async (
		tenantId: string,
		documentRef: string,
		documentId: string,
	): Promise<DocumentAttachment | null> => {
		const attached = await require().list(
			tenantId,
			IMPORT_OWNER_MODULE,
			documentRef,
		);
		return attached.find((record) => record.id === documentId) ?? null;
	};

	return {
		describe,
		async open(tenantId, documentRef, documentId) {
			const record = await describe(tenantId, documentRef, documentId);
			if (!record || record.status === 'deleted') {
				throw new ImportSourceError(
					'SOURCE_NOT_FOUND',
					'The source document is not stored in this workspace.',
					404,
				);
			}
			if (record.scan === 'infected') {
				throw new ImportSourceError(
					'SOURCE_INFECTED',
					'The source document was refused by the malware scanner.',
				);
			}
			if (record.contentType !== IMPORT_CSV_CONTENT_TYPE) {
				throw new ImportSourceError(
					'SOURCE_NOT_CSV',
					'The source document is not a CSV file.',
				);
			}
			if (record.bytes > IMPORT_MAX_CSV_BYTES) {
				throw new ImportSourceError(
					'SOURCE_TOO_LARGE',
					`The source document is larger than ${IMPORT_MAX_CSV_BYTES} bytes.`,
				);
			}
			const read = await require().open(
				tenantId,
				IMPORT_OWNER_MODULE,
				documentRef,
				documentId,
			);
			if (!read) {
				throw new ImportSourceError(
					'SOURCE_NOT_FOUND',
					'The source document has no stored bytes.',
					404,
				);
			}
			return read.body;
		},
	};
}
