import type { DataClassDeclaration } from '@flowdular/kernel';
import type { DocumentsService } from './documents-service.ts';

/** The class id is `documents.core.documents`. */
export const DOCUMENTS_DATA_CLASS_KEY = 'documents';

/**
 * What this module holds, for the workspace's data class catalogue. Documents
 * carry no retention period and no sweep: a document leaves only when a person
 * or its owning module deletes it. The export writes the metadata rows; the
 * bytes stay in the platform store, which the row names, because the export
 * sink carries rows rather than files.
 */
export function documentsDataClass(
	service: () => Promise<DocumentsService>,
): DataClassDeclaration {
	return {
		key: DOCUMENTS_DATA_CLASS_KEY,
		label: 'Documents',
		defaultRetentionDays: null,
		exportable: true,
		export: async ({ tenantId, sink }) =>
			(await service()).exportTo(tenantId, sink),
	};
}

/** The class id is `documents.core.text`. */
export const DOCUMENT_TEXT_DATA_CLASS_KEY = 'text';

/**
 * The text read out of stored documents. A row lives exactly as long as its
 * document, which deletes it in the same transaction, so the class carries no
 * retention and no sweep, and it stays out of the export because the documents
 * class already names the objects the text was read from.
 */
export function documentTextDataClass(): DataClassDeclaration {
	return {
		key: DOCUMENT_TEXT_DATA_CLASS_KEY,
		label: 'Document text',
		defaultRetentionDays: null,
		exportable: false,
		excludedReason:
			'Text read out of the stored documents, which the documents class exports.',
	};
}
