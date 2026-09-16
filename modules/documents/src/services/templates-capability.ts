import type { DocumentTemplates } from '../domain/templates.ts';
import type {
	DocumentTemplateRegistry,
	DocumentTemplatesService,
} from './templates-service.ts';

/**
 * The implementation behind `documents.templates.v1`. Registration reaches the
 * registry at once, while the platform composes; a render resolves the service
 * per call, after the first database lease.
 */
export function createDocumentTemplates(
	registry: DocumentTemplateRegistry,
	service: () => Promise<DocumentTemplatesService>,
): DocumentTemplates {
	return {
		register(moduleId, templates) {
			registry.register(moduleId, templates);
		},
		async render(request) {
			return (await service()).render(request);
		},
		async status(tenantId, jobId) {
			return (await service()).status(tenantId, jobId);
		},
	};
}
