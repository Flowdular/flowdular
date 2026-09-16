import type { DataClassDeclaration } from '@flowdular/kernel';
import type { DocumentsService } from './documents-service.ts';
import type { DocumentTemplatesRepository } from './templates-repository.ts';

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

/** The class id is `documents.core.templates`. */
export const DOCUMENT_TEMPLATES_DATA_CLASS_KEY = 'templates';

/** The class id is `documents.core.renders`. */
export const DOCUMENT_RENDERS_DATA_CLASS_KEY = 'renders';

export const DOCUMENT_RENDERS_RETENTION_DAYS = 90;

const EXPORT_PAGE = 200;
const SWEEP_PAGE = 500;

/**
 * Every version a workspace kept of its templates. Versions are the history a
 * rendered document names, so they carry no retention and no sweep.
 */
export function documentTemplatesDataClass(
	repository: () => Promise<DocumentTemplatesRepository>,
): DataClassDeclaration {
	return {
		key: DOCUMENT_TEMPLATES_DATA_CLASS_KEY,
		label: 'Document template versions',
		defaultRetentionDays: null,
		exportable: true,
		export: async ({ tenantId, sink }) => {
			const open = await repository();
			let after: { key: string; version: number } | null = null;
			let rows = 0;
			let from: Date | null = null;
			let to: Date | null = null;
			for (;;) {
				const page = await open.exportVersions(tenantId, after, EXPORT_PAGE);
				for (const version of page) {
					await sink.write({
						templateKey: version.key,
						version: version.version,
						origin: version.origin,
						body: version.body,
						layout: version.layout,
						inputSchema: version.inputSchema,
						locale: version.locale,
						format: version.format,
						contentSha256: version.contentSha256,
						createdBy: version.createdBy,
						createdAt: new Date(version.createdAt).toISOString(),
					});
					rows += 1;
					const at = new Date(version.createdAt);
					if (!from || at < from) from = at;
					if (!to || at > to) to = at;
				}
				if (page.length < EXPORT_PAGE) break;
				const last = page.at(-1)!;
				after = { key: last.key, version: last.version };
			}
			return { rows, from, to };
		},
	};
}

/**
 * Render jobs. A settled render is swept after 90 days; its document stays,
 * because documents follow their own class. The export leaves the input out:
 * it is cleared when a render settles and the document holds what it printed.
 */
export function documentRendersDataClass(
	repository: () => Promise<DocumentTemplatesRepository>,
): DataClassDeclaration {
	return {
		key: DOCUMENT_RENDERS_DATA_CLASS_KEY,
		label: 'Document renders',
		defaultRetentionDays: DOCUMENT_RENDERS_RETENTION_DAYS,
		exportable: true,
		sweep: async ({ tenantId, cutoff, limit }) => ({
			removed: await (
				await repository()
			).sweepRenders(
				tenantId,
				cutoff.getTime(),
				Math.min(Math.max(Math.trunc(limit), 1), SWEEP_PAGE),
			),
		}),
		export: async ({ tenantId, sink }) => {
			const open = await repository();
			let after: { createdAt: number; id: string } | null = null;
			let rows = 0;
			let from: Date | null = null;
			let to: Date | null = null;
			for (;;) {
				const page = await open.exportRenders(tenantId, after, EXPORT_PAGE);
				for (const render of page) {
					await sink.write({
						id: render.id,
						templateKey: render.templateKey,
						version: render.version,
						ownerModule: render.ownerModule,
						recordRef: render.recordRef,
						inputDigest: render.inputDigest,
						format: render.format,
						status: render.status,
						documentId: render.documentId,
						errorCode: render.errorCode,
						generation: render.generation,
						attempts: render.attempts,
						requestedBy: render.requestedBy,
						createdAt: new Date(render.createdAt).toISOString(),
						finishedAt:
							render.finishedAt === null
								? null
								: new Date(render.finishedAt).toISOString(),
					});
					rows += 1;
					from ??= new Date(render.createdAt);
					to = new Date(render.createdAt);
				}
				if (page.length < EXPORT_PAGE) break;
				const last = page.at(-1)!;
				after = { createdAt: last.createdAt, id: last.id };
			}
			return { rows, from, to };
		},
	};
}
