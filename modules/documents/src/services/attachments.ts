import type { DocumentAttachments } from '../domain/attachments.ts';
import {
	documentAttachment,
	type DocumentsService,
} from './documents-service.ts';

/**
 * The implementation behind `documents.attachments.v1`. It resolves the service
 * per call rather than holding one, so the capability can be registered while
 * the platform composes, before the first database lease is taken.
 */
export function createDocumentAttachments(
	service: () => Promise<DocumentsService>,
): DocumentAttachments {
	return {
		async list(tenantId, ownerModule, recordRef) {
			const records = await (
				await service()
			).listAttached(tenantId, ownerModule, recordRef);
			return records.map(documentAttachment);
		},
		async open(tenantId, ownerModule, recordRef, id) {
			return (await service()).openAttached(
				tenantId,
				ownerModule,
				recordRef,
				id,
			);
		},
		async delete(tenantId, ownerModule, recordRef, id) {
			return (await service()).removeAttached(
				tenantId,
				ownerModule,
				recordRef,
				id,
			);
		},
	};
}
