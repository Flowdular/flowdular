import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { documentsAgentTools } from './agent/tools.ts';
import {
	DOCUMENTS_ATTACHMENTS_CAPABILITY,
	type DocumentAttachments,
} from './domain/attachments.ts';
import {
	DOCUMENTS_TEXT_CAPABILITY,
	type DocumentTextExtraction,
} from './domain/text.ts';
import {
	createDocumentsRoutes,
	createDocumentsRuntime,
} from './server/index.ts';
import { createDocumentAttachments } from './services/attachments.ts';
import {
	DOCUMENTS_TEMPLATES_CAPABILITY,
	type DocumentTemplates,
} from './domain/templates.ts';
import {
	documentRendersDataClass,
	documentsDataClass,
	documentTemplatesDataClass,
	documentTextDataClass,
} from './services/data-classes.ts';
import { createDocumentTemplates } from './services/templates-capability.ts';
import {
	CONNECTORS_EGRESS_CAPABILITY,
	createDocumentOcr,
	documentOcrConfig,
	type ConnectorEgress,
} from './services/text/ocr.ts';
import { createDocumentTextExtraction } from './services/text-service.ts';
import {
	documentsMaxObjectBytes,
	documentsQuotaBytes,
	documentsReadUrlSeconds,
	DOCUMENTS_MODULE_SETTINGS,
	workspaceTimeZone,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	/* connectors.core is an optional requirement and is not ordered first, so
	   the egress policy is resolved on every OCR call rather than here. */
	const ocr = createDocumentOcr({
		config: documentOcrConfig(context.environment),
		egress: () =>
			context.capabilities.get<ConnectorEgress>(CONNECTORS_EGRESS_CAPABILITY) ??
			undefined,
	});
	const runtime = createDocumentsRuntime({
		databases: context.databases,
		storage: context.storage,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		/* An upload may come from another module's worker, outside any request,
		   so the workspace is primed here rather than assumed. */
		quotaBytes: async (tenantId) => {
			await context.settings.prime(tenantId);
			return documentsQuotaBytes(context.settings, tenantId);
		},
		readUrlSeconds: () => documentsReadUrlSeconds(context.settings),
		ocr,
		timeZone: async (tenantId) => {
			await context.settings.prime(tenantId);
			return workspaceTimeZone(context.settings, tenantId);
		},
	});
	/* Registered while the platform composes, so a module that holds records can
	   resolve it in its own composition before any request runs. */
	context.capabilities.register<DocumentAttachments>(
		DOCUMENTS_ATTACHMENTS_CAPABILITY,
		createDocumentAttachments(() => runtime.service()),
	);
	context.capabilities.register<DocumentTextExtraction>(
		DOCUMENTS_TEXT_CAPABILITY,
		createDocumentTextExtraction(() => runtime.textService()),
	);
	context.capabilities.register<DocumentTemplates>(
		DOCUMENTS_TEMPLATES_CAPABILITY,
		createDocumentTemplates(runtime.templates, () =>
			runtime.templatesService(),
		),
	);
	context.agentTools.register(documentsAgentTools(runtime));
	/* The catalogue is sealed before start hooks run, so what this module holds
	   is declared here rather than on the first request. */
	context.dataClasses.declare([
		documentsDataClass(() => runtime.service()),
		documentTextDataClass(),
		documentTemplatesDataClass(() => runtime.templatesRepository()),
		documentRendersDataClass(() => runtime.templatesRepository()),
	]);
	return {
		routes: createDocumentsRoutes(context.auth, runtime, {
			maxObjectBytes: documentsMaxObjectBytes(
				context.environment,
				context.workspaceRoot,
			),
		}),
		settings: DOCUMENTS_MODULE_SETTINGS,
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
