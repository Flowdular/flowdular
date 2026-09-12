export {
	documentAttachment,
	DocumentsService,
	DocumentsServiceError,
	DOCUMENTS_STORAGE_MODULE,
} from './documents-service.ts';
export type { DocumentsServiceOptions } from './documents-service.ts';
export { createDocumentAttachments } from './attachments.ts';
export {
	documentsDataClass,
	DOCUMENTS_DATA_CLASS_KEY,
} from './data-classes.ts';
export type { DocumentsRepository } from './repository.ts';
export {
	DatabaseDocumentsRepository,
	migrateDocumentsDatabase,
} from './database-repository.ts';
export { databaseMigrations } from './migration.ts';
