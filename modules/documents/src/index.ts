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
	DOCUMENT_TEXT_LIMITS,
	DOCUMENT_TEXT_PAGE_BREAK,
	DOCUMENT_TEXT_REASONS,
	DOCUMENT_TEXT_STATUSES,
	DOCUMENTS_TEXT_CAPABILITY,
} from './domain/text.ts';
export type {
	DocumentText,
	DocumentTextBytesInput,
	DocumentTextExtraction,
	DocumentTextOptions,
	DocumentTextPageRange,
	DocumentTextReason,
	DocumentTextStatus,
} from './domain/text.ts';

export {
	DEFAULT_TEMPLATE_MARGINS,
	DOCUMENT_RENDER_STATUSES,
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	DOCUMENT_TEMPLATE_LOCALES,
	DOCUMENT_TEMPLATE_ORIGINS,
	DOCUMENT_TEMPLATE_PAGE_SIZES,
	DOCUMENTS_TEMPLATES_CAPABILITY,
} from './domain/templates.ts';
export type {
	DocumentRenderAnswer,
	DocumentRenderPrincipal,
	DocumentRenderRequest,
	DocumentRenderStatus,
	DocumentTemplateDefinition,
	DocumentTemplateFormat,
	DocumentTemplateLayout,
	DocumentTemplateLocale,
	DocumentTemplateMargins,
	DocumentTemplateOrigin,
	DocumentTemplatePageSize,
	DocumentTemplates,
	TemplateIssue,
} from './domain/templates.ts';
export { templateInputSchemaFromFields } from './domain/template-schema.ts';
export type {
	TemplateArraySchema,
	TemplateEntityField,
	TemplateInputIssue,
	TemplateInputSchema,
	TemplateObjectSchema,
	TemplateScalarSchema,
} from './domain/template-schema.ts';

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
