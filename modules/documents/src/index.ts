import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { DOCUMENTS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'documents.navigation',
			label: 'Documents',
			href: '/documents',
			order: 50,
			permission: DOCUMENTS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(DOCUMENTS_PERMISSIONS),
} satisfies RegisteredModule;

export { DOCUMENTS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A module that owns records imports the identifier
   and the types from here and resolves the implementation through the
   capability registry; nothing else in this module is meant to be imported by
   another one. */
export { DOCUMENTS_ATTACHMENTS_CAPABILITY } from './domain/attachments.ts';
export type {
	DocumentAttachment,
	DocumentAttachmentBody,
	DocumentAttachments,
} from './domain/attachments.ts';

export {
	DOCUMENT_LIMITS,
	DOCUMENT_SCANS,
	DOCUMENT_STATUSES,
} from './domain/types.ts';
export type {
	DocumentFilters,
	DocumentReadUrl,
	DocumentScan,
	DocumentStatus,
	DocumentsFile,
	UploadDocumentInput,
} from './domain/types.ts';

export { DocumentsServiceError } from './services/documents-service.ts';
